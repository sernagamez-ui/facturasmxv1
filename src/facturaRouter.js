/**
 * facturaRouter.js — Orquestador de facturación
 */

const os   = require('os');
const path = require('path');

const { facturarPetro7 }       = require('./portales/petro7');
const { facturarOxxoGas }      = require('./portales/oxxogas');
const { facturarOxxoTienda }   = require('./portales/oxxoTienda');
const { generarFacturaHEB }    = require('./portales/heb');
const { facturarAlsea }        = require('./portales/alsea');
const { facturar7Eleven }     = require('./portales/7eleven');
const { mensajeDeducibilidad, calcularDeducibilidadGasolina } = require('./deducibilidad');
const { ALSEA_OPERADOR_MAP, ALSEA_BRANDS } = require('./ticketReader');
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

async function procesarFactura(ticketData, userData, phone) {
  const { comercio } = ticketData;
  const outputDir = path.join(os.tmpdir(), 'cotas', phone, Date.now().toString());

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

      const fs   = require('fs');
      const mkdirp = (dir) => fs.mkdirSync(dir, { recursive: true });
      mkdirp(outputDir);

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

    // ── No soportado ────────────────────────────────────────────────────
    } else {
      return {
        ok: false, comercio,
        error: 'comercio_no_soportado',
        userMessage: `⏳ La facturación automática de *${comercio}* estará disponible pronto.\n\nPor ahora puedes facturar manualmente en su portal.`,
      };
    }

  } catch (err) {
    return {
      ok: false, comercio,
      error: err.message,
      userMessage: `⚠️ *No pude leer todos los datos del ticket.*\n\n${err.message}\n\n¿Puedes tomar otra foto más clara y cercana?`,
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
  };
  const nombre = nombres[comercio] || comercio;

  let msg = `✅ *¡Factura lista!*\n\n`;
  msg += `🏪 ${nombre}\n`;
  if (ticketData.tipoGasolina) msg += `⛽ ${ticketData.tipoGasolina}\n`;
  if (ticketData.litros)       msg += `🔢 ${ticketData.litros} litros\n`;
  if (ticketData.total)        msg += `💰 $${Number(ticketData.total).toFixed(2)} MXN\n`;
  if (ticketData.fecha)        msg += `📅 ${ticketData.fecha}\n`;
  if (resultado.uuid)          msg += `🔖 UUID: \`${resultado.uuid}\`\n`;

  if (resultado.pdfPath || resultado.xmlPath) {
    msg += `\n📎 Te envío los archivos:\n`;
    if (resultado.pdfPath) msg += `  • PDF ✓\n`;
    if (resultado.xmlPath) msg += `  • XML ✓\n`;
  } else if (resultado.envioPorCorreo) {
    msg += `\n📧 Factura enviada al correo *${userData.email}*\n`;
    msg += `_(Revisa spam si no llega en 5 min)_\n`;
  }

  msg += mensajeDeducibilidad(ticketData, userData.regimen);
  return msg;
}

function armarMensajeError(error, comercio) {
  const nombres = {
    petro7: 'Petro 7', oxxogas: 'OXXO Gas', oxxo: 'OXXO', heb: 'HEB',
    '7eleven': '7-Eleven', sieveEleven: '7-Eleven',
    starbucks: 'Starbucks', dominos: "Domino's", burgerking: 'Burger King',
    chilis: "Chili's", cpk: 'California Pizza Kitchen', pfchangs: "P.F. Chang's",
    italiannis: "Italianni's", vips: 'VIPS', popeyes: 'Popeyes',
    cheesecake: 'The Cheesecake Factory', elporton: 'El Portón', peiwei: 'Pei Wei',
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
      'Revisa en Railway:\n' +
      '• `SEVENELEVEN_HTTP_PROXY` con formato `http://usuario:contraseña@host:puerto` (contraseña con caracteres especiales en *URL encode*)\n' +
      '• O proxy sin credenciales en la URL + variables `SEVENELEVEN_PROXY_USER` y `SEVENELEVEN_PROXY_PASS`\n\n' +
      'Si *no* quieres usar proxy, borra `SEVENELEVEN_HTTP_PROXY` y también `HTTP_PROXY` / `HTTPS_PROXY` del servicio (a veces Railway o la plantilla las define y provocan 407).'
    );
  }
  if (errorCode === 'PORTAL_FORBIDDEN' || error.includes('403') || error.includes('bloqueo')) {
    return (
      '🚫 *7-Eleven bloqueó la conexión desde este servidor (403).*\n\n' +
      'No es un error de tu ticket: el portal suele rechazar IPs de datacenters (Railway, etc.).\n\n' +
      '*Qué puedes hacer:*\n' +
      '• Configura en Railway la variable `SEVENELEVEN_HTTP_PROXY` con un proxy HTTP residencial en México\n' +
      '• O corre Cotas en tu máquina local / red de casa (misma IP que usarías en el navegador)\n\n' +
      '_Sin eso, la facturación automática de 7-Eleven desde la nube no es confiable._'
    );
  }
  if (errorCode === 'TICKET_INVALID' || error.includes('Ticket no facturable') || error.includes('no encontrado')) {
    return (
      '🔍 *7-Eleven no reconoce este folio.*\n\n' +
      'Lo más frecuente es que el número largo del código de barras se haya leído mal (un solo dígito mal ya invalida el ticket) o que el portal aún no lo tenga registrado.\n\n' +
      'Prueba:\n' +
      '• Foto más nítida con el código de barras *completo* y el número impreso debajo legible\n' +
      '• Compara con el portal manual si el folio coincide\n' +
      '• Si acabas de pagar, reintenta en unos minutos'
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

module.exports = { procesarFactura };
