/**
 * facturaRouter.js — Orquestador de facturación
 */

const os   = require('os');
const path = require('path');

const { facturarPetro7 }       = require('./portales/petro7');
const { facturarOxxoGas }      = require('./portales/oxxogas');
const { generarFacturaHEB }    = require('./portales/heb');
const { facturarAlsea }        = require('./portales/alsea');
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
    petro7: 'Petro 7', oxxogas: 'OXXO Gas', heb: 'HEB',
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
    petro7: 'Petro 7', oxxogas: 'OXXO Gas', heb: 'HEB',
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

module.exports = { procesarFactura };
