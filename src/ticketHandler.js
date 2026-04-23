/**
 * src/ticketHandler.js
 *
 * Diferencias clave vs WhatsApp:
 * - Descarga la imagen vía Telegram API (no Meta)
 * - El servidor envía PDF y XML con sendDocument (stream); copia al correo vía Resend (mailer.js)
 * - Los portales petro7.js y oxxogas.js NO cambian — retornan pdfPath/xmlPath igual
 */

const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const axios = require('axios');

const { leerTicket }                                      = require('./ticketReader');
const { procesarFactura }                                 = require('./facturaRouter');
const { clasificarGasto, calcularDeducibilidad, mensajeFiscal } = require('./fiscalRules');
const { mensajeDeducibilidad } = require('./deducibilidad');
const db                                                  = require('./db');
const { enviarFactura }                                   = require('./mailer');
const { ORIGON_CDC_CONFIG }                               = require('./portales/origonCdc');

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
      ok: false,
    };
  }

  if (!ticketData || !ticketData.comercio) {
    return {
      mensajeBot:
        '❓ No reconocí el tipo de ticket. Por ahora proceso: Petro 7, OXXO Gas, Orsan, Pemex, 🏪 OXXO tienda, Office Depot, Home Depot, Alsea y HEB.',
      ok: false,
    };
  }

  // ── 3. Verificar pago en efectivo ──────────────────────────────────────────
  if (ticketData.esEfectivo && ticketData.comercio !== 'oxxogas') {
    return {
      mensajeBot:
        '⚠️ *Gasolina pagada en efectivo*\n\n' +
        'Los pagos en efectivo *no son deducibles* ante el SAT (Art. 27 LISR).\n\n' +
        'Para deducir, paga con tarjeta débito/crédito o transferencia. 💳',
      ok: false,
    };
  }

  // ── 4. Mensaje de procesando (lo envía server.js antes de esperar) ─────────
  const mensajeProcesando = `⛽ Tramitando tu factura de *${_nombreComercio(ticketData.comercio)}*... ⏳`;

  // ── 5. Llamar al facturaRouter existente ──────────────────────────────────
  // procesarFactura() ya maneja petro7 y oxxogas y retorna { ok, pdfPath, xmlPath, userMessage }
  const phone = userData.telegramId || userId; // TelegramId en onboarding; fallback por usuarios viejos
  const resultado = await procesarFactura(ticketData, userData, phone, outputDir);

  // ── 5b. Si el portal necesita datos manuales, guardar estado de retry ─────
  console.log(
    `[ticketHandler] resultado.esperandoDatosAlsea=${resultado.esperandoDatosAlsea} ` +
    `resultado.errorCode=${resultado.errorCode || 'n/a'} ` +
    `portalStatus=${resultado.portalStatus || 'n/a'} ` +
    `snippet=${(resultado.portalSnippet || '').slice(0, 160)} ` +
    `resultado.error=${resultado.error}`
  );
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

  if (resultado.esperandoEstacion && ticketData.comercio === 'petro7') {
    db.setState(userId, {
      step: 'ESPERANDO_ESTACION_PETRO7',
      ticketData: { ...ticketData },
    });
    console.log(`[ticketHandler] Estado ESPERANDO_ESTACION_PETRO7 guardado para userId=${userId}`);
  }

  // ── 6. Guardar factura en historial ───────────────────────────────────────
  let totalParaUi = null;
  if (resultado.ok) {
    _guardarEnHistorial(userId, ticketData, resultado, userData);
    totalParaUi = ticketData.total ?? ticketData.monto ?? null;
    if (ticketData.comercio !== 'officedepot') {
      enviarFactura({
        email: userData.email,
        comercio: ticketData.comercio,
        total: ticketData.total ?? ticketData.monto,
        uuid: resultado.uuid,
        xmlPath: resultado.xmlPath || null,
        pdfPath: resultado.pdfPath || null,
      }).catch((e) => console.warn('[ticketHandler] Email factura:', e.message));
    }
  }

  // ── 7. Construir mensaje de respuesta ────────────────────────────────────
  const mensajeBot = resultado.ok
    ? (resultado.userMessage || _mensajeExito(ticketData, resultado, userData))
    : (resultado.userMessage || _mensajeError(resultado, ticketData));

  return {
    mensajeProcesando,
    mensajeBot,
    pdfPath: resultado.pdfPath || null,
    xmlPath: resultado.xmlPath || null,
    ok: !!resultado.ok,
    totalParaUi,
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
    return { mensajeBot: '❌ No hay un ticket pendiente. Mándame una nueva foto.', ok: false };
  }

  // Parsear: "283991736 38742" o "283991736  38742" (espacios flexibles)
  const match = texto.trim().match(/^(\d{6,12})\s+(\d{4,6})$/);
  if (!match) {
    return {
      mensajeBot:
        '❌ No entendí los datos. Escribe el número de *ticket* y *tienda* separados por un espacio.\n\n' +
        'Ejemplo: `283991736 38742`\n\n' +
        '_(El ticket tiene 9 dígitos y la tienda 5 dígitos — búscalos en la sección "Datos para facturar" de tu ticket)_',
      ok: false,
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
    enviarFactura({
      email: userData.email,
      comercio: ticketData.comercio,
      total: ticketData.total ?? ticketData.monto,
      uuid: resultado.uuid,
      xmlPath: resultado.xmlPath || null,
      pdfPath: resultado.pdfPath || null,
    }).catch((e) => console.warn('[ticketHandler] Email factura (Alsea retry):', e.message));
  }

  const mensajeBot = resultado.ok
    ? _mensajeExito(ticketData, resultado, userData)
    : (resultado.userMessage || _mensajeError(resultado, ticketData));

  return {
    mensajeBot,
    pdfPath: resultado.pdfPath || null,
    xmlPath: resultado.xmlPath || null,
    ok: !!resultado.ok,
  };
}


// ── Guardar en historial ──────────────────────────────────────────────────────

/** Total del comprobante en CFDI 3.3 / 4.0 (atributo Total del nodo Comprobante). */
function leerTotalDesdeCfdiXml(xmlPath) {
  try {
    if (!xmlPath || !fs.existsSync(xmlPath)) return null;
    const xml = fs.readFileSync(xmlPath, 'utf8');
    const i = xml.indexOf('Comprobante');
    if (i === -1) return null;
    const head = xml.slice(i, i + 4000);
    const m = head.match(/\bTotal="([0-9.]+)"/);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function resolverMontoFactura(ticketData, resultado) {
  const raw =
    ticketData.total ?? ticketData.monto ?? resultado?.total ?? resultado?.monto;
  let n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  const desdeXml = resultado?.xmlPath ? leerTotalDesdeCfdiXml(resultado.xmlPath) : null;
  if (desdeXml != null) return desdeXml;
  return Number.isFinite(n) ? n : 0;
}

function _guardarEnHistorial(userId, ticketData, resultado, userData) {
  const montoTotal = resolverMontoFactura(ticketData, resultado);
  if (montoTotal > 0) {
    if (ticketData.total == null || Number(ticketData.total) === 0) ticketData.total = montoTotal;
    if (ticketData.monto == null || Number(ticketData.monto) === 0) ticketData.monto = montoTotal;
  }
  const metodoPago =
    ticketData.esEfectivo || ticketData.metodoPago === 'efectivo' ? 'efectivo' : 'tarjeta';
  const ticketId = ticketData.noTicket || ticketData.folio || ticketData.itu || ticketData.num_ticket || 'n/a';
  const deduccion = calcularDeducibilidad({
    comercio: ticketData.comercio,
    total: montoTotal,
    regimen: userData.regimen,
    metodoPago,
    usoCfdi: ticketData.usoCfdi || userData.usoCFDI || userData.usoCfdi,
    categoria: ticketData.categoria,
    ticketId,
  });
  const montoDeducible = Number(deduccion.montoDeducible) || 0;
  const ivaAcreditable = Number(deduccion.ivaAcreditable) || 0;
  db.guardarFactura(userId, {
    portal:         ticketData.comercio,
    comercio:       ticketData.comercio,
    monto:          montoTotal,
    total:          montoTotal,
    deducibleISR:   montoDeducible,
    montoDeducible,
    ivaAcreditable,
    deducible:      deduccion.deducible,
    metodoPago:     ticketData.metodoPago || metodoPago,
    tipoGasolina:   ticketData.tipoGasolina || null,
    litros:         ticketData.litros || null,
    fecha:          ticketData.fecha || ticketData.fechaTicket || null,
    regimen:        userData.regimen,
    uuid:           resultado.uuid || null,
    folioFiscal:    resultado.folioFiscal || resultado.newItu || null,
    nota_negocio:   null,
  });
}

// ── Helpers de mensaje ────────────────────────────────────────────────────────

function _nombreComercio(comercio) {
  if (ORIGON_CDC_CONFIG[comercio]) return ORIGON_CDC_CONFIG[comercio].label;
  const nombres = {
    petro7: 'Petro 7', oxxogas: 'OXXO Gas', oxxo: 'OXXO',
    orsan: 'Orsan', mobil_nl: 'Mobil NL', pemex: 'Pemex',
    alsea: 'Alsea', starbucks: 'Starbucks', dominos: "Domino's", burgerking: 'Burger King',
    chilis: "Chili's", cpk: 'California Pizza Kitchen', pfchangs: "P.F. Chang's",
    italiannis: "Italianni's", vips: 'VIPS', popeyes: 'Popeyes',
    cheesecake: 'The Cheesecake Factory', elporton: 'El Portón', heb: 'HEB',
    mcdonalds: "McDonald's", '7eleven': '7-Eleven',
    officedepot: 'Office Depot',
    homedepot: 'Home Depot',
  };
  return nombres[comercio] || comercio;
}

function _mensajeExito(ticketData, resultado, userData, xmlEnviado) {
  const nombre  = _nombreComercio(ticketData.comercio);
  const ticketId = ticketData.noTicket || ticketData.folio || ticketData.itu || ticketData.num_ticket || 'n/a';
  const gasto   = clasificarGasto(ticketData.comercio, { categoriaVision: ticketData.categoria, ticketId, skipClasificacionLog: true });
  const iconLinea = gasto.icon || '📄';
  const esCombustible = gasto.categoria === 'combustible';

  let msg = `✅ *¡Factura lista!*\n\n`;
  msg += `${iconLinea} ${nombre}\n`;
  if (ticketData.tipoGasolina) msg += `🛢 ${ticketData.tipoGasolina}\n`;
  if (ticketData.litros)       msg += `🔢 ${ticketData.litros}L\n`;
  const totalFiscal = ticketData.total ?? ticketData.monto;
  if (totalFiscal)             msg += `💰 $${Number(totalFiscal).toFixed(2)}\n`;
  if (ticketData.fecha)        msg += `📅 ${ticketData.fecha}\n`;

  msg += '\n';

  if (totalFiscal && userData.regimen) {
    if (esCombustible) {
      const td = { ...ticketData, total: totalFiscal };
      msg += mensajeDeducibilidad(td, userData.regimen);
    } else {
      msg += mensajeFiscal({
        comercio:   ticketData.comercio,
        total:      totalFiscal,
        regimen:    userData.regimen,
        metodoPago: ticketData.metodoPago || (ticketData.esEfectivo ? 'efectivo' : 'tarjeta'),
        usoCfdi:    ticketData.usoCfdi || userData.usoCFDI || userData.usoCfdi || 'G03',
        categoria:  ticketData.categoria,
        ticketId,
        esViatico:  !!ticketData.esViatico,
      });
    }
  } else if (userData.regimen === '605' && !totalFiscal) {
    msg += esCombustible
      ? `ℹ️ Como asalariado, la gasolina no es deducible en tu declaración anual.\n\n`
      : `ℹ️ Régimen 605: este tipo de gasto no es deducible en tu declaración anual.\n\n`;
  }

  if (resultado.pdfPath && resultado.xmlPath) {
    msg += `📎 Te envío PDF y XML en mensajes separados.\n`;
  } else if (resultado.pdfPath) {
    msg += `📄 Te envío el PDF en el siguiente mensaje.\n`;
  }
  if (xmlEnviado) msg += `📧 XML enviado a \`${userData.email}\`\n`;
  else if (resultado.envioPorCorreo) msg += `📧 El portal lo enviará a tu correo en breve`;
  else if (
    userData.email &&
    process.env.RESEND_API_KEY &&
    (resultado.xmlPath || resultado.pdfPath)
  ) {
    msg += `📧 Copia (XML/PDF) a tu correo vía Factural.\n`;
  }

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

/**
 * Reintenta Petro 7 cuando el usuario corrige estación (y opcionalmente folio) por Telegram.
 * Texto: "6131" o "6131 2518259"
 */
async function handleRetryPetro7Estacion(userId, texto, userData) {
  const state = db.getState(userId);

  if (!state || state.step !== 'ESPERANDO_ESTACION_PETRO7' || !state.ticketData) {
    return { mensajeBot: '❌ No hay un ticket Petro 7 pendiente. Mándame una nueva foto del ticket.', ok: false };
  }

  const compact = texto.trim().replace(/\s+/g, ' ');
  let noEstacion;
  let noTicketOpt;
  const mTwo = compact.match(/^(\d{4})\s+(\d{5,10})$/);
  const mOne = compact.match(/^(\d{4})$/);
  if (mTwo) {
    noEstacion = mTwo[1];
    noTicketOpt = mTwo[2];
  } else if (mOne) {
    noEstacion = mOne[1];
  } else {
    return {
      mensajeBot:
        '❌ Escribe la *Estación* (4 dígitos) o *Estación* y *Folio* separados por un espacio.\n\n' +
        'Ejemplos: `6131` o `6131 2518259`',
      ok: false,
    };
  }

  db.setState(userId, null);

  const ticketData = {
    ...state.ticketData,
    comercio: 'petro7',
    noEstacion,
  };
  if (noTicketOpt) ticketData.noTicket = noTicketOpt;

  console.log(
    `[ticketHandler] Retry Petro 7 manual: noEstacion=${noEstacion}` +
      (noTicketOpt ? ` noTicket=${noTicketOpt}` : '')
  );

  const outputDir = path.join(os.tmpdir(), 'cotas', userId, Date.now().toString());
  const resultado = await procesarFactura(ticketData, userData, userId, outputDir);

  if (resultado.esperandoEstacion) {
    db.setState(userId, { step: 'ESPERANDO_ESTACION_PETRO7', ticketData: { ...ticketData } });
  }

  if (resultado.ok) {
    _guardarEnHistorial(userId, ticketData, resultado, userData);
    enviarFactura({
      email: userData.email,
      comercio: ticketData.comercio,
      total: ticketData.total ?? ticketData.monto,
      uuid: resultado.uuid,
      xmlPath: resultado.xmlPath || null,
      pdfPath: resultado.pdfPath || null,
    }).catch((e) => console.warn('[ticketHandler] Email factura (Petro7 retry):', e.message));
  }

  const mensajeBot = resultado.ok
    ? _mensajeExito(ticketData, resultado, userData)
    : (resultado.userMessage || _mensajeError(resultado, ticketData));

  return {
    mensajeBot,
    pdfPath: resultado.pdfPath || null,
    xmlPath: resultado.xmlPath || null,
    ok: !!resultado.ok,
  };
}

module.exports = { handleTicket, handleRetryAlsea, handleRetryPetro7Estacion };
