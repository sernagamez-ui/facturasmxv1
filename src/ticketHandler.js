/**
 * src/ticketHandler.js
 *
 * Diferencias clave vs WhatsApp:
 * - Descarga la imagen vía Telegram API (no Meta)
 * - Envía PDF con ctx.replyWithDocument() (no uploadMedia)
 * - XML va al email del usuario (igual que antes)
 * - Los portales petro7.js y oxxogas.js NO cambian — retornan pdfPath/xmlPath igual
 */

const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const axios = require('axios');
const nodemailer = require('nodemailer');

const { leerTicket }                                      = require('./ticketReader');
const { procesarFactura }                                 = require('./facturaRouter');
const { calcularDeducibilidadGasolina }                   = require('./deducibilidad');
const db                                                  = require('./db');

/**
 * Procesa una foto de ticket recibida por Telegram
 */
async function handleTicket(ctx, fileId, userData) {
  const userId    = String(ctx.from.id);
  const outputDir = path.join(os.tmpdir(), 'cotas', userId, Date.now().toString());
  fs.mkdirSync(outputDir, { recursive: true });

  // ── 1. Descargar imagen de Telegram ───────────────────────────────────────
  const fileLink  = await ctx.telegram.getFileLink(fileId);
  const imgRes    = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
  const imgPath   = path.join(outputDir, 'ticket.jpg');
  fs.writeFileSync(imgPath, Buffer.from(imgRes.data));

  // ── 2. Leer ticket con Vision ──────────────────────────────────────────────
  // ticketReader.js espera (Buffer, mimeType)
  const imageBuffer = Buffer.from(imgRes.data);
  let ticketData;
  try {
    ticketData = await leerTicket(imageBuffer, 'image/jpeg');
  } catch (err) {
    console.error('[ticketHandler] Error Vision:', err.message);
    return {
      mensajeBot: '❌ No pude leer el ticket. ¿Puedes enviar una foto más clara y bien iluminada?',
    };
  }

  if (!ticketData || !ticketData.comercio) {
    return {
      mensajeBot: '❓ No reconocí el tipo de ticket. Por ahora proceso gasolineras: Petro 7, OXXO Gas, Orsan y Pemex.',
    };
  }

  // ── 3. Verificar pago en efectivo ──────────────────────────────────────────
  if (ticketData.esEfectivo && ticketData.comercio !== 'oxxogas') {
    return {
      mensajeBot:
        '⚠️ *Gasolina pagada en efectivo*\n\n' +
        'Los pagos en efectivo *no son deducibles* ante el SAT (Art. 27 LISR).\n\n' +
        'Para deducir, paga con tarjeta débito/crédito o transferencia. 💳',
    };
  }

  // ── 4. Mensaje de procesando (lo envía server.js antes de esperar) ─────────
  const mensajeProcesando = `⛽ Tramitando tu factura de *${_nombreComercio(ticketData.comercio)}*... ⏳`;

  // ── 5. Llamar al facturaRouter existente ──────────────────────────────────
  // procesarFactura() ya maneja petro7 y oxxogas y retorna { ok, pdfPath, xmlPath, userMessage }
  const phone = userData.telegramId; // para el outputDir interno de facturaRouter
  const resultado = await procesarFactura(ticketData, userData, phone, outputDir);

  // ── 5b. Si el portal necesita datos manuales, guardar estado de retry ─────
  console.log(`[ticketHandler] resultado.esperandoDatosAlsea=${resultado.esperandoDatosAlsea} resultado.error=${resultado.error}`);
  if (resultado.esperandoDatosAlsea) {
    const retryState = {
      step: 'ESPERANDO_DATOS_ALSEA',
      ticketData: resultado.ticketData,
    };
    db.setState(userId, retryState);
    console.log(`[ticketHandler] Estado ESPERANDO_DATOS_ALSEA guardado para userId=${userId}`);
    // Verificar que se guardó
    const check = db.getState(userId);
    console.log(`[ticketHandler] Verificación getState: step=${check?.step}`);
  }

  // ── 6. Guardar factura en historial ───────────────────────────────────────
  if (resultado.ok) {
    _guardarEnHistorial(userId, ticketData, resultado, userData);
  }

  // ── 7. Construir mensaje de respuesta ────────────────────────────────────
  const mensajeBot = resultado.ok
    ? _mensajeExito(ticketData, resultado, userData)
    : (resultado.userMessage || _mensajeError(resultado, ticketData));

  return {
    mensajeProcesando,
    mensajeBot,
    pdfPath: resultado.pdfPath || null,
    xmlPath: resultado.xmlPath || null,
  };
}

/**
 * Reintenta facturación Alsea con datos manuales del usuario.
 * Llamado desde server.js cuando state.step === 'ESPERANDO_DATOS_ALSEA'.
 *
 * @param {string} userId
 * @param {string} texto — "283991736 38742" (ticket + tienda)
 * @param {object} userData
 * @returns {object} { mensajeBot, pdfPath, xmlPath }
 */
async function handleRetryAlsea(userId, texto, userData) {
  const state = db.getState(userId);

  if (!state || state.step !== 'ESPERANDO_DATOS_ALSEA' || !state.ticketData) {
    return { mensajeBot: '❌ No hay un ticket pendiente. Mándame una nueva foto.' };
  }

  // Parsear: "283991736 38742" o "283991736  38742" (espacios flexibles)
  const match = texto.trim().match(/^(\d{6,12})\s+(\d{4,6})$/);
  if (!match) {
    return {
      mensajeBot:
        '❌ No entendí los datos. Escribe el número de *ticket* y *tienda* separados por un espacio.\n\n' +
        'Ejemplo: `283991736 38742`\n\n' +
        '_(El ticket tiene 9 dígitos y la tienda 5 dígitos — búscalos en la sección "Datos para facturar" de tu ticket)_',
    };
  }

  const noTicket = match[1];
  const tienda   = match[2];

  // Limpiar estado de retry ANTES de llamar (evita loop si falla de nuevo)
  db.setState(userId, null);

  const ticketData = {
    ...state.ticketData,
    noTicket,
    tienda,
    comercio: 'alsea',
  };

  console.log(`[ticketHandler] Retry Alsea con datos manuales: ticket=${noTicket} tienda=${tienda} operador=${ticketData.operador}`);

  const outputDir = path.join(os.tmpdir(), 'cotas', userId, Date.now().toString());
  const resultado = await procesarFactura(ticketData, userData, userId, outputDir);

  // Si vuelve a fallar con ticket_invalido, ofrecer reintentar otra vez
  if (resultado.esperandoDatosAlsea) {
    db.setState(userId, {
      step: 'ESPERANDO_DATOS_ALSEA',
      ticketData: resultado.ticketData,
    });
  }

  if (resultado.ok) {
    _guardarEnHistorial(userId, ticketData, resultado, userData);
  }

  const mensajeBot = resultado.ok
    ? _mensajeExito(ticketData, resultado, userData)
    : (resultado.userMessage || _mensajeError(resultado, ticketData));

  return {
    mensajeBot,
    pdfPath: resultado.pdfPath || null,
    xmlPath: resultado.xmlPath || null,
  };
}

// ── Guardar en historial ──────────────────────────────────────────────────────

function _guardarEnHistorial(userId, ticketData, resultado, userData) {
  const montoTotal = Number(ticketData.total || ticketData.monto || 0);
  const deduccion  = calcularDeducibilidadGasolina(
    montoTotal,
    ticketData.metodoPago || 'tarjeta',
    userData.regimen
  );
  db.guardarFactura(userId, {
    comercio:       ticketData.comercio,
    total:          montoTotal,
    montoDeducible: deduccion.montoDeducible || 0,
    ivaAcreditable: deduccion.ivaAcreditable || 0,
    deducible:      deduccion.deducible,
    metodoPago:     ticketData.metodoPago || 'tarjeta',
    tipoGasolina:   ticketData.tipoGasolina || null,
    litros:         ticketData.litros || null,
    fecha:          ticketData.fecha || null,
    regimen:        userData.regimen,
    uuid:           resultado.uuid   || null,
    folioFiscal:    resultado.folioFiscal || null,
  });
}

// ── Email XML ─────────────────────────────────────────────────────────────────

async function enviarXmlPorEmail(email, xmlPath, uuid) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('[ticketHandler] Sin credenciales SMTP — XML no enviado por email');
    return;
  }

  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST || 'smtp.gmail.com',
    port:   Number(process.env.SMTP_PORT) || 587,
    secure: false,
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  const filename = uuid
    ? `factura_${uuid.substring(0, 8)}.xml`
    : `factura_${Date.now()}.xml`;

  await transporter.sendMail({
    from:        `"Cotas" <${process.env.SMTP_USER}>`,
    to:          email,
    subject:     '🧾 Tu factura electrónica (XML)',
    text:        'Adjunto encontrarás el archivo XML de tu factura electrónica generada por Cotas.',
    attachments: [{ filename, path: xmlPath, contentType: 'application/xml' }],
  });

  console.log(`[ticketHandler] XML enviado a ${email}`);
}

// ── Helpers de mensaje ────────────────────────────────────────────────────────

function _nombreComercio(comercio) {
  const nombres = {
    petro7: 'Petro 7', oxxogas: 'OXXO Gas', orsan: 'Orsan', mobil_nl: 'Mobil NL', pemex: 'Pemex',
    alsea: 'Alsea', starbucks: 'Starbucks', dominos: "Domino's", burgerking: 'Burger King',
    chilis: "Chili's", cpk: 'California Pizza Kitchen', pfchangs: "P.F. Chang's",
    italiannis: "Italianni's", vips: 'VIPS', popeyes: 'Popeyes',
    cheesecake: 'The Cheesecake Factory', elporton: 'El Portón', heb: 'HEB',
  };
  return nombres[comercio] || comercio;
}

function _mensajeExito(ticketData, resultado, userData, xmlEnviado) {
  const nombre  = _nombreComercio(ticketData.comercio);
  const esDeducible = !['605'].includes(userData.regimen) && !ticketData.esEfectivo;

  let msg = `✅ *¡Factura lista!*\n\n`;
  msg += `⛽ ${nombre}\n`;
  if (ticketData.tipoGasolina) msg += `🛢 ${ticketData.tipoGasolina}\n`;
  if (ticketData.litros)       msg += `🔢 ${ticketData.litros}L\n`;
  if (ticketData.total)        msg += `💰 $${Number(ticketData.total).toFixed(2)}\n`;
  if (ticketData.fecha)        msg += `📅 ${ticketData.fecha}\n`;

  msg += '\n';

  if (esDeducible && ticketData.total) {
    const base = Number(ticketData.total) / 1.16;
    const iva  = Number(ticketData.total) - base;
    msg += `✅ *Deducible al 100%*\n`;
    msg += `💚 IVA acreditable: $${iva.toFixed(2)}\n\n`;
  } else if (userData.regimen === '605') {
    msg += `ℹ️ Como asalariado, la gasolina no es deducible en tu declaración anual.\n\n`;
  }

  msg += `📄 PDF adjunto arriba\n`;
  if (xmlEnviado) msg += `📧 XML enviado a \`${userData.email}\``;
  else if (resultado.envioPorCorreo) msg += `📧 El portal lo enviará a tu correo en breve`;

  return msg;
}

function _mensajeError(resultado, ticketData) {
  const nombre = _nombreComercio(ticketData?.comercio || '?');
  if (resultado.esperandoFolio) return resultado.userMessage;
  if (resultado.esperandoEstacion) return resultado.userMessage;
  if (resultado.esperandoDatosAlsea) return resultado.userMessage;
  return (
    `❌ *No se pudo generar la factura de ${nombre}*\n\n` +
    `Verifica que el ticket sea de este mes y que no hayas facturado antes este folio.\n\n` +
    `Intenta de nuevo en unos minutos.`
  );
}

module.exports = { handleTicket, handleRetryAlsea };
