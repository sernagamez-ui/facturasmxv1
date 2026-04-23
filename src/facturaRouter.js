/**
 * facturaRouter.js — Orquestador de facturación
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { facturarPetro7 }       = require('./portales/petro7');
const { facturarOxxoGas }      = require('./portales/oxxogas');
const { facturarOxxoTienda }   = require('./portales/oxxoTienda');
const { generarFacturaHEB }    = require('./portales/heb');
const { facturarAlsea }        = require('./portales/alsea');
const { facturar7Eleven }     = require('./portales/7eleven');
const { facturarHomeDepot }   = require('./portales/homedepot');
const { facturarWalmartFromTicket } = require('./portales/walmart');
const { facturarOrigonCdc, ORIGON_CDC_CONFIG } = require('./portales/origonCdc');
const { facturarMcDonalds } = require('./portales/mcdonalds');
const { facturar: facturarOfficeDepot, buildUsuario: buildUsuarioOfficeDepot } = require('./portales/officedepot');
const { mensajeDeducibilidad } = require('./deducibilidad');
const { mensajeFiscal } = require('./fiscalRules');
const { ALSEA_OPERADOR_MAP, ALSEA_BRANDS, ORIGON_CDC_BRANDS } = require('./ticketReader');
const db = require('./db');

// Cola simple para OXXO Gas (sesión compartida — una a la vez)
let colaOxxoGas = Promise.resolve();
function encolar(fn) {
  const res = colaOxxoGas.then(fn).catch(fn);
  colaOxxoGas = res.then(() => {}).catch(() => {});
  return res;
}

/**
 * Genera variantes del folio largo 7-Eleven (30–40 dígitos) cuando el lector
 * devuelve longitud atípica pero el portal sigue respondiendo TICKET_INVALID.
 */
function expand7ElevenNoTicketCandidates(rawList) {
  const set = new Set();
  const add = (s) => {
    if (typeof s !== 'string' || !s) return;
    const d = s.replace(/\D/g, '');
    if (/^\d{30,40}$/.test(d)) set.add(d);
  };

  for (const raw of rawList) {
    const d = String(raw || '').replace(/\D/g, '');
    if (!d) continue;

    add(d);

    if (d.length > 40 && d.length <= 48) {
      for (let len = 40; len >= 30; len--) {
        add(d.slice(-len));
        add(d.slice(0, len));
      }
    }

    if (d.length === 36 || d.length === 37) {
      add(d.slice(0, 35));
      add(d.slice(0, 36));
      add(d.slice(1, 36));
      add(d.slice(1));
      add(d.slice(-35));
      add(d.slice(-36));
    }

    if (d.length === 34 || d.length === 33) {
      add(`0${d}`);
      if (d.length === 33) add(`00${d}`);
    }
  }

  return [...set];
}

async function procesarFactura(ticketData, userData, phone, outputDirOverride) {
  const { comercio } = ticketData;
  const outputDir =
    outputDirOverride && String(outputDirOverride).trim()
      ? String(outputDirOverride).trim()
      : path.join(os.tmpdir(), 'cotas', String(phone), Date.now().toString());
  fs.mkdirSync(outputDir, { recursive: true });

  let resultado;

  try {
    // ── Alsea: todas las marcas van al mismo adaptador ──────────────────
    if (ALSEA_BRANDS.has(comercio) || comercio === 'alsea') {
      const operador = ticketData.operador || ALSEA_OPERADOR_MAP[comercio];
      if (!operador) {
        return {
          ok: false, comercio,
          error: 'operador_desconocido',
          userMessage: `⚠️ No pude identificar la marca exacta de Alsea. ¿Puedes tomar otra foto más clara?`,
        };
      }

      validar(ticketData, ['noTicket', 'tienda', 'fecha'], `Alsea/${operador}`);

      resultado = await facturarAlsea({
        operador,
        noTicket: ticketData.noTicket,
        tienda:   ticketData.tienda,
        fecha:    ticketData.fecha,
        userData,
        outputDir,
      });

      // Mapear errores específicos de Alsea a mensajes de usuario
      if (!resultado.ok) {
        const errorMap = {
          ya_facturado:    '📋 Este ticket ya fue facturado anteriormente.',
          fecha_invalida:  '📅 La fecha no coincide con el ticket. ¿La foto está completa?',
          rfc_invalido:    '⚠️ El RFC fue rechazado por el SAT. Verifica tus datos fiscales.',
          datos_fiscales:  '⚠️ Los datos fiscales fueron rechazados. Verifica tu nombre, CP y régimen fiscal.',
        };
        // ticket_invalido → pedir datos manuales (mismo patrón que Petro 7 esperandoEstacion)
        if (resultado.error === 'ticket_invalido') {
          resultado.esperandoDatosAlsea = true;
          resultado.ticketData = ticketData;
          resultado.userMessage = `⚠️ No pude leer correctamente los datos del ticket de *${operador}*.\n\nEscribe los datos de la sección *"Datos para facturar"* de tu ticket en este formato:\n\n*Ticket:* (9 dígitos) *Tienda:* (5 dígitos)\n\nEjemplo: \`283991736 38742\``;
        } else {
          resultado.userMessage = resultado.userMessage || errorMap[resultado.error] ||
            `⚠️ No se pudo generar la factura: ${resultado.mensaje || resultado.error}`;
        }
      }

    // ── Office Depot ────────────────────────────────────────────────────
    } else if (comercio === 'officedepot') {
      validar(ticketData, ['itu'], 'Office Depot');
      const amount = ticketData.amount ?? ticketData.total;
      if (amount == null || amount === '') {
        throw new Error(
          'Faltan datos del ticket de Office Depot: amount/total. ¿La foto está completa y legible?'
        );
      }
      const portalEmail = `${String(phone).replace(/\D/g, '')}@factural.mx`;
      const usuarioOd = buildUsuarioOfficeDepot(userData, portalEmail);
      const ticket = { itu: ticketData.itu, amount: Number(amount) };
      resultado = await facturarOfficeDepot({
        ticket,
        usuario: usuarioOd,
        emailPersonal: userData.email,
      });
      if (!resultado.ok) {
        resultado.userMessage =
          `⚠️ *Office Depot*\n\n${resultado.error}` +
          (resultado.portalMsg ? `\n\n_Detalle: ${String(resultado.portalMsg).slice(0, 280)}_` : '');
      } else {
        resultado.userMessage = resultado.message;
        resultado.envioPorCorreo = true;
      }

    // ── Petro 7 ─────────────────────────────────────────────────────────
    } else if (comercio === 'petro7') {
      console.log('[DEBUG Petro7] ticketData:', JSON.stringify(ticketData));
      validar(ticketData, ['noEstacion', 'noTicket', 'wid'], 'Petro 7');
      if (String(ticketData.noTicket) === String(ticketData.noEstacion)) {
        return {
          ok: false, comercio, error: 'vision_error', ticketData,
          esperandoFolio: true,
          userMessage: '⚠️ No pude leer correctamente el folio del ticket.\n\nResponde con el número de *Folio* (7 dígitos) que aparece en tu ticket y lo intento de nuevo.',
        };
      }
      resultado = await facturarPetro7({
        gasolinera: ticketData.noEstacion,
        folio:      ticketData.noTicket,
        webId:      ticketData.wid,
        fecha:      ticketData.fechaTicket || ticketData.fecha,
        userData,
        outputDir,
      });

    // ── OXXO Gas ────────────────────────────────────────────────────────
    } else if (comercio === 'oxxogas') {
      const tieneEstacionDirecta = !!ticketData.estacion;
      const tieneNombre = !!ticketData.nombreEstacion;

      if (!tieneEstacionDirecta && !tieneNombre) {
        throw new Error('Faltan datos del ticket de OXXO Gas: estación. ¿La foto está completa y legible?');
      }
      validar(ticketData, ['noTicket', 'monto'], 'OXXO Gas');

      if (ticketData.fecha) {
        const fechaMs    = new Date(ticketData.fecha).getTime();
        const fechaValida = fechaMs > new Date('2020-01-01').getTime();
        const horas       = (Date.now() - fechaMs) / 3_600_000;
        if (fechaValida && horas > 23) {
          return {
            ok: false, comercio,
            error: 'ticket_vencido',
            userMessage: `⏰ *Este ticket de OXXO Gas ya venció.*\n\nOXXO Gas solo acepta facturas dentro de las *24 horas* después de la carga.\n\nPara el próximo ticket, mándame la foto el mismo día. 📸`,
          };
        }
      }

      const estacionId = ticketData.estacion || ticketData.nombreEstacion || null;
      if (!estacionId) {
        return {
          ok: false, comercio,
          error: 'estacion_desconocida',
          userMessage: '⛽ No pude identificar la estación de OXXO Gas. ¿Puedes tomar una foto más clara?',
        };
      }

      resultado = await encolar(() => facturarOxxoGas({
        estacion: estacionId,
        noTicket: ticketData.noTicket,
        monto:    ticketData.monto,
        esEfectivo: ticketData.esEfectivo || ticketData.metodoPago === 'efectivo',
        userData,
        outputDir,
      }));

    // ── OXXO tienda (conveniencia) ───────────────────────────────────────
    } else if (comercio === 'oxxo') {
      validar(ticketData, ['folio', 'venta', 'fecha', 'total'], 'OXXO');
      resultado = await facturarOxxoTienda({
        fecha: ticketData.fecha,
        folio: ticketData.folio,
        venta: ticketData.venta,
        total: ticketData.total,
        userData,
        outputDir,
      });

    // ── HEB ─────────────────────────────────────────────────────────────
    } else if (comercio === 'heb') {
      validar(ticketData, ['sucursal', 'noTicket', 'fecha', 'total'], 'HEB');
      const { xml, pdf, uuid, folio, serie } = await generarFacturaHEB(ticketData, userData);

      const xmlPath = path.join(outputDir, `heb_${ticketData.noTicket}.xml`);
      const pdfPath = path.join(outputDir, `heb_${ticketData.noTicket}.pdf`);
      fs.writeFileSync(xmlPath, xml);
      fs.writeFileSync(pdfPath, pdf);

      resultado = {
        ok: true,
        xmlPath,
        pdfPath,
        uuid,
        folio,
        serie,
        envioPorCorreo: false,
      };

    // ── 7-Eleven ───────────────────────────────────────────────────────
    } else if (comercio === '7eleven' || comercio === 'sieveEleven') {
      validar(ticketData, ['noTicket'], '7-Eleven');

      const baseRaw = [
        ticketData.noTicket,
        ...(ticketData.noTicketCandidates || []),
      ].map((v) => String(v || '').replace(/\D/g, ''));
      const candidates = expand7ElevenNoTicketCandidates(baseRaw);

      if (candidates.length === 0) {
        return {
          ok: false,
          comercio,
          error: '7eleven_folio_invalido',
          errorCode: 'INVALID_INPUT',
          userMessage:
            '⚠️ No obtuve un número de ticket de 7-Eleven válido (30–40 dígitos). ' +
            'Manda otra foto con el código de barras y el número de abajo bien nítidos.',
        };
      }

      const MAX_INTENTOS = 12;
      let r = null;
      let intentos = 0;
      for (const candidate of candidates) {
        if (intentos >= MAX_INTENTOS) break;
        intentos++;
        const intento = await facturar7Eleven(
          { noTicket: candidate },
          {
            rfc:     userData.rfc,
            nombre:  userData.nombre,
            cp:      userData.cp,
            regimen: userData.regimen,
            email:   userData.email,
            usoCFDI: comercioUsoCFDI(comercio, userData),
          }
        );
        console.log(
          `[facturaRouter][7eleven] intento code=${intento.code || 'ok'} len=${candidate.length} ` +
          `portalStatus=${intento.portalStatus || 'n/a'} snippet=${(intento.portalSnippet || '').slice(0, 120)} ` +
          `ticket=***${candidate.slice(-6)}`
        );
        if (intento.success) {
          ticketData.noTicket = candidate;
          r = intento;
          break;
        }
        r = intento;
        if (intento.code !== 'TICKET_INVALID' && intento.code !== 'INVALID_INPUT') {
          break;
        }
      }

      if (!r.success) {
        resultado = {
          ok: false,
          error: r.error,
          errorCode: r.code || null,
          portalStatus: r.portalStatus || null,
          portalSnippet: r.portalSnippet || null,
          userMessage: armarMensaje7ElevenError(r.error, r.code),
        };
      } else {
        // Escribir PDF y XML a archivos
        const fs = require('fs');
        fs.mkdirSync(outputDir, { recursive: true });

        const pdfPath = path.join(outputDir, `7eleven_${r.uuid}.pdf`);
        const xmlPath = path.join(outputDir, `7eleven_${r.uuid}.xml`);
        fs.writeFileSync(pdfPath, Buffer.from(r.b64Pdf, 'base64'));
        fs.writeFileSync(xmlPath, r.xml);

        resultado = {
          ok: true,
          pdfPath,
          xmlPath,
          uuid: r.uuid,
          folio: r.folio,
          serie: r.serie,
          total: r.total,
        };

        // Inyectar total al ticketData para el mensaje de éxito
        if (!ticketData.total && r.total) ticketData.total = r.total;
      }

    // ── Home Depot: HTTP puro, sin sesión ───────────────────────
    } else if (comercio === 'homedepot') {
      validar(ticketData, ['noTicket'], 'HomeDepot');

      resultado = await facturarHomeDepot({
        noTicket: ticketData.noTicket,
        userData,
        outputDir,
      });

    // ── Walmart México (Walmex: Walmart, Sam's, Bodega Aurrera) — Playwright + correo ──
    } else if (comercio === 'walmart') {
      const trRaw = ticketData.tr ?? ticketData.numTransaccion;
      validar({ ...ticketData, tr: trRaw }, ['noTicket', 'tr'], 'Walmart');
      resultado = await facturarWalmartFromTicket({
        noTicket: String(ticketData.noTicket).replace(/\D/g, ''),
        tr: String(trRaw).replace(/\D/g, ''),
        userData,
      });

    // ── Grupo Galería (Origon CDC): Carl's Jr., IHOP, BWW, etc. ───────────
    } else if (ORIGON_CDC_BRANDS.has(comercio)) {
      const branchCode = ticketData.branchCode ?? ticketData.tienda;
      const sucursalNombre = ticketData.sucursalNombre;
      validar(ticketData, ['noTicket', 'fecha', 'total'], ORIGON_CDC_CONFIG[comercio]?.label || comercio);
      const bStr = String(branchCode ?? '').trim();
      const nStr = String(sucursalNombre ?? '').trim();
      if (!bStr && !nStr) {
        resultado = {
          ok: false,
          comercio,
          error: 'faltan_sucursal',
          userMessage:
            '⚠️ Hace falta *sucursal* para facturar: el número (en "Datos para facturar") o al menos el nombre de la tienda (ej. San Pedro) en el ticket. Manda otra foto mostrando encabezado o esa sección.',
        };
      } else {
        resultado = await facturarOrigonCdc({
          comercio,
          branchCode: bStr,
          sucursalNombre: nStr || undefined,
          noTicket: String(ticketData.noTicket).trim(),
          fecha: ticketData.fecha,
          total: Number(ticketData.total),
          userData,
          outputDir,
        });
      }

      if (!resultado.ok) {
        if (resultado.error === 'faltan_sucursal') {
          /* userMessage already set */
        } else {
          const portal = resultado.mensaje
            ? `📋 *Portal:* ${String(resultado.mensaje).replace(/\*/g, '')}\n\n`
            : '';
          const sugerenciaMap = {
            ticket_invalido:
              '💡 Revisa *sucursal* (código, ej. 15 = San Pedro), *folio* solo dígitos (3,451,112 → 3451112), *fecha* y *TOTAL* con IVA (no el neto).',
            sucursal_desconocida:
              '💡 Incluye en la foto el encabezado con nombre de tienda o "Datos para facturar" con el número de sucursal.',
            preview_error: '💡 Los datos fiscales o el ticket no pasaron la validación del portal.',
            emision_error: '💡 No se pudo timbrar. Intenta de nuevo en unos minutos.',
            portal_forbidden:
              '💡 El portal devolvió 403; en hosting a veces hace falta proxy en MX o red local.',
            proxy_auth: '💡 Revisa PROXY_URL_ROTATING (proxy 407).',
            red_tls_proxy:
              '💡 Conexión inestable hacia *carlsjr.cdc.origon.cloud* (TLS/proxy). En Railway: prueba otra `PROXY_URL_ROTATING`, o define *ORIGON_CDC_USE_PROXY=0* (directo) si el portal acepta la IP. Los reintentos ya van en el servidor.',
            origon_error: `💡 ${String(resultado.mensaje || 'Error al contactar al portal')}`,
          };
          const sugerencia =
            sugerenciaMap[resultado.error] ||
            `💡 ${String(resultado.mensaje || resultado.error || 'Error al facturar')}`;
          resultado.userMessage = portal + sugerencia;
        }
      }

    // ── McDonald's México ────────────────────────────────────────────────
    } else if (comercio === 'mcdonalds') {
      const td = {
        number_store: ticketData.number_store ?? ticketData.numberStore,
        num_ticket: ticketData.num_ticket ?? ticketData.noTicket,
        num_caja: ticketData.num_caja ?? ticketData.caja,
        fecha: ticketData.fecha,
        total: ticketData.total,
      };
      validar(td, ['number_store', 'num_ticket', 'num_caja', 'fecha', 'total'], "McDonald's");

      resultado = await facturarMcDonalds({
        number_store: String(td.number_store).trim(),
        num_ticket: String(td.num_ticket).trim(),
        num_caja: String(td.num_caja).trim(),
        fecha: td.fecha,
        total: Number(td.total),
        userData,
        outputDir,
      });

      if (!resultado.ok) {
        const errMap = {
          ya_facturado: '📋 Este ticket de McDonald\'s ya fue facturado.',
          ticket_invalido:
            '🔍 El portal no reconoce el ticket. Verifica tienda, número de ticket, caja, fecha y total (deben coincidir con el ticket).',
          datos_fiscales: '⚠️ Faltan RFC, régimen fiscal o código postal para facturar en McDonald\'s.',
          emision_error:
            '⚠️ El portal validó el ticket pero no pudo timbrar al confirmar. Revisa RFC, régimen y correo en tu perfil; si el mensaje del SAT aparece abajo, corrige según indique. Reintenta en unos minutos.',
          portal_forbidden:
            '🚫 El portal bloqueó la conexión (403). Desde la nube puede hacer falta proxy en México o ejecutar Cotas en red local.',
          proxy_auth: '🔐 El proxy respondió 407. Revisa credenciales en PROXY_URL_ROTATING.',
        };
        const detalle =
          resultado.error === 'emision_error' && resultado.portalSnippet
            ? `\n\n📋 *Portal:* ${String(resultado.portalSnippet).replace(/\*/g, '').slice(0, 400)}`
            : '';
        resultado.userMessage =
          (errMap[resultado.error] || `⚠️ ${resultado.mensaje || resultado.error || 'Error al facturar'}`) + detalle;
      }

    // ── No soportado ────────────────────────────────────────────────────
    } else {
      return {
        ok: false, comercio,
        error: 'comercio_no_soportado',
        userMessage: `⏳ La facturación automática de *${comercio}* estará disponible pronto.\n\nPor ahora puedes facturar manualmente en su portal.`,
      };
    }

  } catch (err) {
    const raw = String(err.message ?? err);
    const hebTextoLargo =
      comercio === 'heb' &&
      /HEB solo correo|pantalla muestra|HEB timeout: sin|ticket no encontrado|No se encontraron/i.test(raw);
    const techHebPlano =
      comercio === 'heb' &&
      /waitForResponse|Timeout \d+ms exceeded|playwright|HEB sin|portal HEB/i.test(raw) &&
      !/HEB solo correo|pantalla muestra|HEB timeout: sin|ticket no encontrado|No se encontraron/i.test(raw);
    const userMessage = hebTextoLargo
      ? `⚠️ *HEB*\n\n${raw.slice(0, 1800)}`
      : techHebPlano
        ? `⚠️ *Problema con el portal HEB al generar la factura o la respuesta tardó demasiado.*\n\n_${raw.slice(0, 400)}_\n\n` +
          `Reintenta en unos minutos. Si sigue igual, factura en facturacion.heb.com.mx o revisa el deploy.`
        : `⚠️ *No pude leer todos los datos del ticket.*\n\n${raw}\n\n¿Puedes tomar otra foto más clara y cercana?`;
    return {
      ok: false, comercio,
      error: raw,
      userMessage,
    };
  }

  resultado.comercio = comercio;
  if (!resultado.userMessage) {
    resultado.userMessage = resultado.ok
      ? armarMensajeExito(resultado, ticketData, userData, comercio)
      : armarMensajeError(resultado.error, comercio);
  }

  return resultado;
}

function validar(data, campos, nombre) {
  const faltantes = campos.filter(c => !data[c]);
  if (faltantes.length > 0) {
    throw new Error(
      `Faltan datos del ticket de ${nombre}: *${faltantes.join(', ')}*. ¿La foto está completa y legible?`
    );
  }
}

function armarMensajeExito(resultado, ticketData, userData, comercio) {
  const nombres = {
    petro7: 'Petro 7', oxxogas: 'OXXO Gas', oxxo: 'OXXO', heb: 'HEB',
    '7eleven': '7-Eleven', sieveEleven: '7-Eleven',
    // Alsea brands
    starbucks: 'Starbucks', dominos: "Domino's", burgerking: 'Burger King',
    chilis: "Chili's", cpk: 'California Pizza Kitchen', pfchangs: "P.F. Chang's",
    italiannis: "Italianni's", vips: 'VIPS', popeyes: 'Popeyes',
    cheesecake: 'The Cheesecake Factory', elporton: 'El Portón', peiwei: 'Pei Wei',
    alsea: ticketData.operador || 'Alsea',
    carlsjr: ORIGON_CDC_CONFIG.carlsjr?.label || "Carl's Jr.",
    ihop: ORIGON_CDC_CONFIG.ihop?.label || 'IHOP',
    bww: ORIGON_CDC_CONFIG.bww?.label || 'Buffalo Wild Wings',
    mcdonalds: 'McDonald\'s',
    officedepot: 'Office Depot',
    homedepot: 'Home Depot',
    walmart: 'Walmart',
  };
  const nombre = nombres[comercio] || comercio;

  let msg = `✅ *¡Factura lista!*\n\n`;
  msg += `🏪 ${nombre}\n`;
  if (ticketData.tipoGasolina) msg += `⛽ ${ticketData.tipoGasolina}\n`;
  if (ticketData.litros)       msg += `🔢 ${ticketData.litros} litros\n`;
  const totalFiscal = ticketData.total ?? ticketData.monto;
  if (totalFiscal)              msg += `💰 $${Number(totalFiscal).toFixed(2)} MXN\n`;
  if (ticketData.fecha)         msg += `📅 ${ticketData.fecha}\n`;
  if (resultado.uuid)           msg += `🔖 UUID: \`${resultado.uuid}\`\n`;

  if (resultado.pdfPath || resultado.xmlPath) {
    msg += `\n📎 Te envío los archivos:\n`;
    if (resultado.pdfPath) msg += `  • PDF ✓\n`;
    if (resultado.xmlPath) msg += `  • XML ✓\n`;
  } else if (resultado.envioPorCorreo) {
    msg += `\n📧 Factura enviada al correo *${userData.email}*\n`;
    msg += `_(Revisa spam si no llega en 5 min)_\n`;
  }

  if (totalFiscal) {
    const ticketId = ticketData.noTicket || ticketData.folio || ticketData.itu || ticketData.num_ticket || 'n/a';
    if (comercio === 'petro7' || comercio === 'oxxogas') {
      const td = { ...ticketData, total: totalFiscal };
      msg += mensajeDeducibilidad(td, userData.regimen);
    } else {
      // Deducibilidad: `ticketData.categoria` viene de Vision / fusión en ticketReader (giro, no marca);
      // `clasificarGasto` en fiscalRules usa eso como verdad primaria y solo cae a nombre de comercio si falta o es "otros".
      msg += mensajeFiscal({
        comercio,
        total:        totalFiscal,
        regimen:      userData.regimen,
        metodoPago:   ticketData.metodoPago || (ticketData.esEfectivo ? 'efectivo' : 'tarjeta'),
        usoCfdi:      comercioUsoCFDI(comercio, userData),
        categoria:    ticketData.categoria,
        ticketId,
        esViatico:    !!ticketData.esViatico,
      });
    }
  }
  return msg;
}

function armarMensajeError(error, comercio) {
  const nombres = {
    petro7: 'Petro 7', oxxogas: 'OXXO Gas', oxxo: 'OXXO', heb: 'HEB',
    '7eleven': '7-Eleven', sieveEleven: '7-Eleven',
    starbucks: 'Starbucks', dominos: "Domino's", burgerking: 'Burger King',
    chilis: "Chili's", cpk: 'California Pizza Kitchen', pfchangs: "P.F. Chang's",
    italiannis: "Italianni's", vips: 'VIPS', popeyes: 'Popeyes',
    cheesecake: 'The Cheesecake Factory',     elporton: 'El Portón', peiwei: 'Pei Wei',
    carlsjr: ORIGON_CDC_CONFIG.carlsjr?.label || "Carl's Jr.",
    ihop: ORIGON_CDC_CONFIG.ihop?.label || 'IHOP',
    bww: ORIGON_CDC_CONFIG.bww?.label || 'Buffalo Wild Wings',
    mcdonalds: 'McDonald\'s',
    officedepot: 'Office Depot',
    homedepot: 'Home Depot',
    walmart: 'Walmart',
  };
  const nombre = nombres[comercio] || comercio;

  let msg = `⚠️ *No se pudo generar la factura de ${nombre}*\n\n`;
  if (error?.includes('CAPTCHA')) {
    msg += `Problema técnico con el CAPTCHA. Intenta en unos minutos.`;
  } else if (error?.includes('rechazó') || error?.includes('incorrecto')) {
    msg += `El portal rechazó los datos. Verifica que la foto esté completa y clara.`;
  } else if (error?.includes('mismo mes')) {
    msg += `HEB solo permite facturar tickets del mes en curso. Este ticket ya no es facturable.`;
  } else if (error?.includes('30 días') || error?.includes('vencido')) {
    msg += `Este ticket ya pasó el plazo de 30 días para facturar.`;
  } else if (
    comercio === 'heb' &&
    (String(error).includes('ticket no encontrado') || String(error).includes('No se encontraron'))
  ) {
    msg +=
      `HEB no localizó ese ticket: el *número de folio/ticket*, la *fecha* y el *total* ` +
      `deben coincidir con el ticket *exactamente*  como en la caja. A veces la foto se lee mal. ` +
      `Comprueba en el impreso o prueba otra compra.`;
  } else {
    msg += `Error: ${error}\n\nIntenta de nuevo o escribe *ayuda*.`;
  }
  return msg;
}

function comercioUsoCFDI(comercio, userData) {
  // 7-Eleven: G03 (gastos en general) por defecto, G01 si es para reventa
  return userData.usoCFDI || 'G03';
}

function armarMensaje7ElevenError(error, errorCode) {
  if (!error) return '⚠️ Error desconocido al facturar en 7-Eleven.';
  if (errorCode === 'PROXY_AUTH_REQUIRED' || error.includes('407')) {
    return (
      '🔐 *El proxy pide autenticación (HTTP 407).*\n\n' +
      'Revisa en Railway la variable `PROXY_URL_ROTATING`:\n' +
      '• Formato `http(s)://usuario:contraseña@host:puerto` (contraseña con caracteres especiales en *URL encode*)\n\n' +
      'Si no usas proxy, borra `PROXY_URL_ROTATING` y revisa `HTTP_PROXY` / `HTTPS_PROXY` del servicio (a veces provocan 407).'
    );
  }
  if (errorCode === 'PORTAL_FORBIDDEN' || error.includes('403') || error.includes('bloqueo')) {
    return (
      '🚫 *7-Eleven bloqueó la conexión desde este servidor (403).*\n\n' +
      'No es un error de tu ticket: el portal suele rechazar IPs de datacenters (Railway, etc.).\n\n' +
      '*Qué puedes hacer:*\n' +
      '• Define `PROXY_URL_ROTATING` con un proxy HTTP residencial en México (ver `src/proxyAgent.js`)\n' +
      '• O corre Cotas en tu máquina local / red de casa (misma IP que usarías en el navegador)\n\n' +
      '_Sin eso, la facturación automática de 7-Eleven desde la nube no es confiable._'
    );
  }
  if (
    errorCode === 'TICKET_INVALID' ||
    error.includes('Ticket no facturable') ||
    error.includes('no encontrado') ||
    /no exist/i.test(String(error))
  ) {
    const detalle =
      errorCode === 'TICKET_INVALID' && String(error).length > 15
        ? `\n\n📋 *Portal:* ${String(error).replace(/\*/g, '').slice(0, 240)}`
        : '';
    return (
      '🔍 *7-Eleven no reconoce este folio.*\n\n' +
      'Lo más frecuente es que el número largo del código de barras se haya leído mal (un solo dígito mal ya invalida el ticket) o que el portal aún no lo tenga registrado.\n\n' +
      'Prueba:\n' +
      '• Foto más nítida con el código de barras *completo* y el número impreso debajo legible\n' +
      '• Compara el número con el portal manual (debe coincidir con la línea bajo el código de barras)\n' +
      '• Si acabas de pagar, reintenta en unos minutos' +
      detalle
    );
  }
  if (error.includes('ya fue facturado'))   return '📋 Este ticket de 7-Eleven ya fue facturado anteriormente.';
  if (error.includes('vencido') || error.includes('mes'))
    return '📅 Este ticket ya venció. 7-Eleven permite facturar dentro del mes + los primeros 5 días del siguiente.';
  if (error.includes('captcha') || error.includes('Captcha'))
    return '🔄 Problema con el captcha del portal. Intenta de nuevo en un momento.';
  if (error.includes('no disponible'))
    return '🔧 El portal de 7-Eleven está temporalmente fuera de servicio. Intenta más tarde.';
  return `⚠️ No se pudo facturar en 7-Eleven: ${error}`;
}

/** Comercios con adaptador HTTP/Playwright en `procesarFactura` (p. ej. WhatsApp debe permitirlos). */
function comercioFacturableAutomatico(comercio) {
  if (!comercio) return false;
  if (comercio === 'alsea') return true;
  if (ALSEA_BRANDS.has(comercio)) return true;
  if (ORIGON_CDC_BRANDS.has(comercio)) return true;
  return [
    'petro7',
    'oxxogas',
    'oxxo',
    'heb',
    '7eleven',
    'sieveEleven',
    'mcdonalds',
    'officedepot',
    'homedepot',
    'walmart',
  ].includes(comercio);
}

function etiquetaComercio(comercio) {
  if (!comercio) return 'este comercio';
  const origon = ORIGON_CDC_CONFIG[comercio];
  if (origon) return origon.label;
  if (comercio === 'alsea') return 'Alsea';
  const alseaOp = ALSEA_OPERADOR_MAP[comercio];
  if (alseaOp) return alseaOp;
  const n = {
    petro7: 'Petro 7',
    oxxogas: 'OXXO Gas',
    oxxo: 'OXXO',
    heb: 'HEB',
    '7eleven': '7-Eleven',
    sieveEleven: '7-Eleven',
    mcdonalds: "McDonald's",
    officedepot: 'Office Depot',
    homedepot: 'Home Depot',
    walmart: 'Walmart',
  };
  return n[comercio] || comercio;
}

module.exports = { procesarFactura, comercioFacturableAutomatico, etiquetaComercio };
