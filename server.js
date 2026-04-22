/**
 * COTAS — Servidor Telegram (producción)
 * Cola async + SQLite + clasificación fiscal + personas morales
 */

require('dotenv').config();
const axios = require('axios');
axios.get('https://api.ipify.org?format=json')
  .then(r => console.log('[Railway] IP pública de salida:', r.data.ip))
  .catch(e => console.log('[Railway] No pude obtener IP:', e.message));

const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const cron    = require('node-cron');

const db                                = require('./src/db');
const { createEmailInboundHandler }     = require('./src/webhooks/emailInbound');
const { handleTicket, handleRetryAlsea, handleRetryPetro7Estacion } = require('./src/ticketHandler');
const { enqueue, stats: queueStats }    = require('./src/facturaQueue');
const { leerTicket }                    = require('./src/ticketReader');
const { clasificarGasto } = require('./src/fiscalRules');
const { verificarUsoCfdi, generarBotonesUsoCfdi, guardarEstadoEsperandoUsoCfdi, recuperarEstadoUsoCfdi } = require('./src/usoCfdiFlow');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const app = express();
const IS_RAILWAY = Boolean(process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_ENVIRONMENT_ID);
/** Solo true después de `bot.launch()` (polling). En webhook no hay launch → no llamar `bot.stop()`. */
let isPollingActive = false;

// Health: usa la misma resolución de rutas que `src/db.js` (evita falsos positivos).
app.get('/health', (_req, res) => {
  const storage = typeof db.getStorageInfo === 'function' ? db.getStorageInfo() : {};
  res.status(200).json({
    ok: true,
    ts: new Date().toISOString(),
    mode: process.env.WEBHOOK_URL ? 'webhook' : (IS_RAILWAY ? 'webhook-auto' : 'polling'),
    isRailway: IS_RAILWAY,
    envDataDir: process.env.DATA_DIR || null,
    dataDir: storage.dataDirResolved,
    ...storage,
  });
});

// ── Admin routes ─────────────────────────────────────────────────────────────
const adminRoutes = require('./src/adminRoutes');
app.use('/admin', adminRoutes);

// ── /start ───────────────────────────────────────────────────────────────────

bot.start(async (ctx) => {
  const userId = String(ctx.from.id);
  const nombre = ctx.from.first_name || 'amigo';

  if (db.isOnboarded(userId)) {
    const user = db.getUser(userId);
    return ctx.reply(
      `¡Hola de nuevo, ${user.nombre.split(' ')[0]}! 👋\n\nMándame la foto de tu ticket y te tramito la factura. 📸`,
      Markup.keyboard([['📊 Mis facturas', '⚙️ Mi cuenta'], ['❓ Ayuda']]).resize()
    );
  }

  await ctx.reply(
    `¡Hola ${nombre}! 👋 Soy *Cotas*, tu agente de facturas automáticas.\n\n` +
    `📸 Foto de tu ticket → CFDI en tu chat en 2 minutos.\n\n` +
    `Necesito tus datos fiscales — son 5 preguntas rápidas:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('✅ Empezar', 'ob_start')]]),
    }
  );
});

// ── Onboarding ───────────────────────────────────────────────────────────────

bot.action('ob_start', async (ctx) => {
  await ctx.answerCbQuery();
  db.setState(String(ctx.from.id), { step: 'RFC' });
  await ctx.reply('*Paso 1 / 5 — RFC*\n\nEscribe tu RFC:', { parse_mode: 'Markdown' });
});

const REGIMENES_FISICA = { '605': 'Sueldos y Salarios', '612': 'Act. Empresarial y Profesional', '626': 'RESICO' };
const REGIMENES_MORAL  = { '601': 'General de Ley', '603': 'Sin fines de lucro', '620': 'Sociedades Cooperativas', '622': 'Act. Agrícolas', '623': 'Sociedades', '624': 'Coordinados', '625': 'Plataformas Tecnológicas' };

Object.keys({ ...REGIMENES_FISICA, ...REGIMENES_MORAL }).forEach(cod => {
  bot.action(`reg_${cod}`, async (ctx) => {
    await ctx.answerCbQuery();
    const userId = String(ctx.from.id);
    const state  = db.getState(userId);
    db.setState(userId, { ...state, regimen: cod, step: 'EMAIL' });
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    await ctx.reply(
      `✅ Régimen ${cod} guardado.\n\n*Paso 5 / 5 — Email*\n\nEscribe tu correo (recibirás el XML ahí):`,
      { parse_mode: 'Markdown' }
    );
  });
});

// ── Uso CFDI — respuesta a botones inline ────────────────────────────────────

bot.action(/^usocfdi_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId  = String(ctx.from.id);
  const usoCfdi = ctx.match[1];
  const chatId  = ctx.chat.id;

  const estado = recuperarEstadoUsoCfdi(userId);
  if (!estado) {
    return ctx.editMessageText('⏳ Este ticket ya fue procesado o expiró. Mándame otra foto.');
  }

  await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  const msgProc = await ctx.reply('⏳ Procesando tu factura...');

  const userData   = db.getUser(userId);
  const ticketData = { ...estado.ticketData, usoCfdi };

  enqueue({
    comercio: ticketData.comercio,
    job: async () => {
      const fakeCtx = { from: { id: userId }, telegram: bot.telegram };
      return await handleTicket(fakeCtx, estado.fileId, { ...userData, usoCfdi });
    },
    onComplete: async (resultado) => {
      await bot.telegram.deleteMessage(chatId, msgProc.message_id).catch(() => {});
      await _enviarResultado(chatId, resultado, ticketData, userData, usoCfdi);
    },
    onError: async (err) => {
      await bot.telegram.deleteMessage(chatId, msgProc.message_id).catch(() => {});
      console.error('[server] Error en cola (usoCfdi):', err.message);
      await bot.telegram.sendMessage(chatId, '❌ Error procesando. Intenta de nuevo.');
    },
  });
});

bot.on('text', async (ctx) => {
  const userId = String(ctx.from.id);
  const texto  = ctx.message.text.trim();
  if (texto.startsWith('/')) return;

  if (texto === '📊 Mis facturas') return handleMisFacturas(ctx);
  if (texto === '⚙️ Mi cuenta')   return handleMiCuenta(ctx);
  if (texto === '❓ Ayuda')        return handleAyuda(ctx);

  const state = db.getState(userId);

  // Retry Petro 7 — estación / folio corregidos por texto
  if (state?.step === 'ESPERANDO_ESTACION_PETRO7') {
    const userData = db.getUser(userId);
    const msg = await ctx.reply('⏳ Reintentando factura Petro 7...');
    try {
      const resultado = await handleRetryPetro7Estacion(userId, texto, userData);
      await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});
      await ctx.reply(
        resultado.mensajeBot,
        resultado.ok === true ? { parse_mode: 'Markdown' } : {}
      );
      if (resultado.pdfPath && fs.existsSync(resultado.pdfPath)) {
        await ctx.replyWithDocument({ source: resultado.pdfPath, filename: `factura_${Date.now()}.pdf` }, { caption: '📄 PDF' });
      }
      if (resultado.xmlPath && fs.existsSync(resultado.xmlPath)) {
        await ctx.replyWithDocument({ source: resultado.xmlPath, filename: `factura_${Date.now()}.xml` }, { caption: '🗂 XML' });
      }
    } catch (err) {
      await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});
      db.setState(userId, null);
      await ctx.reply('❌ Error reintentando. Mándame otra foto del ticket.');
    }
    return;
  }

  // Retry Alsea
  if (state?.step === 'ESPERANDO_DATOS_ALSEA') {
    const userData = db.getUser(userId);
    const msg = await ctx.reply('⏳ Reintentando factura...');
    try {
      const resultado = await handleRetryAlsea(userId, texto, userData);
      await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});
      await ctx.reply(
        resultado.mensajeBot,
        resultado.ok === true ? { parse_mode: 'Markdown' } : {}
      );
      if (resultado.pdfPath && fs.existsSync(resultado.pdfPath)) {
        await ctx.replyWithDocument({ source: resultado.pdfPath, filename: `factura_${Date.now()}.pdf` }, { caption: '📄 PDF' });
      }
      if (resultado.xmlPath && fs.existsSync(resultado.xmlPath)) {
        await ctx.replyWithDocument({ source: resultado.xmlPath, filename: `factura_${Date.now()}.xml` }, { caption: '🗂 XML' });
      }
    } catch (err) {
      await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});
      db.setState(userId, null);
      await ctx.reply('❌ Error reintentando. Mándame otra foto del ticket.');
    }
    return;
  }

  if (state?.step) return handleOnboarding(ctx, userId, texto, state);

  if (db.isOnboarded(userId)) {
    return ctx.reply('Mándame la *foto* de tu ticket para facturarlo. 📸', { parse_mode: 'Markdown' });
  }
  ctx.reply('Usa /start para comenzar.');
});

// ── Onboarding pasos ─────────────────────────────────────────────────────────

async function handleOnboarding(ctx, userId, texto, state) {
  switch (state.step) {
    case 'RFC': {
      const rfc      = texto.toUpperCase().replace(/\s/g, '');
      const esFisica = /^[A-Z&Ñ]{4}\d{6}[A-Z0-9]{3}$/.test(rfc);
      const esMoral  = /^[A-Z&Ñ]{3}\d{6}[A-Z0-9]{3}$/.test(rfc);
      if (!esFisica && !esMoral) {
        return ctx.reply('❌ RFC inválido.\n\n• Persona física: 13 caracteres (ej: GAHM850101ABC)\n• Persona moral: 12 caracteres (ej: GYS850101AB3)\n\nIntenta de nuevo:');
      }
      db.setState(userId, { ...state, rfc, esMoral: rfc.length === 12, step: 'NOMBRE' });
      const tipo = rfc.length === 12 ? '🏢 Persona moral detectada.' : '👤 Persona física detectada.';
      return ctx.reply(`✅ RFC guardado. ${tipo}\n\n*Paso 2 / 5 — Nombre o Razón Social*\n\nEscríbelo *exactamente* como aparece en tu Constancia del SAT:`, { parse_mode: 'Markdown' });
    }
    case 'NOMBRE': {
      if (texto.length < 3) return ctx.reply('Escríbelo completo:');
      db.setState(userId, { ...state, nombre: texto.toUpperCase(), step: 'CP' });
      return ctx.reply('✅ Nombre guardado.\n\n*Paso 3 / 5 — Código Postal Fiscal*\n\nEscribe tu CP (5 dígitos):', { parse_mode: 'Markdown' });
    }
    case 'CP': {
      if (!/^\d{5}$/.test(texto)) return ctx.reply('❌ El CP debe ser de 5 dígitos. Intenta de nuevo:');
      db.setState(userId, { ...state, cp: texto, step: 'REGIMEN' });
      const opciones = state.esMoral
        ? Object.entries(REGIMENES_MORAL).map(([cod, desc]) => [Markup.button.callback(`${cod} — ${desc}`, `reg_${cod}`)])
        : Object.entries(REGIMENES_FISICA).map(([cod, desc]) => [Markup.button.callback(`${cod} — ${desc}`, `reg_${cod}`)]);
      return ctx.reply('✅ CP guardado.\n\n*Paso 4 / 5 — Régimen Fiscal*\n\nSelecciona el tuyo:', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(opciones) });
    }
    case 'EMAIL': {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(texto)) return ctx.reply('❌ Email inválido. Intenta de nuevo:');
      const user = {
        telegramId: userId, rfc: state.rfc, nombre: state.nombre, cp: state.cp,
        regimen: state.regimen, email: texto.toLowerCase(), esMoral: state.esMoral || false,
        plan: 'free', creadoEn: new Date().toISOString(),
      };
      db.setUser(userId, user);
      db.setState(userId, null);
      const tipoLabel = user.esMoral ? '🏢 Persona moral' : '👤 Persona física';
      return ctx.reply(
        `🎉 *¡Registro listo!*\n\n${tipoLabel}\n📋 RFC: \`${user.rfc}\`\n👤 ${user.nombre}\n📮 CP: ${user.cp}\n📊 Régimen: ${user.regimen}\n📧 ${user.email}\n\n` +
          `📬 Si un comercio solo manda la factura al correo, usa: \`${userId}@factural.mx\`\n\n` +
          `📸 Ahora mándame la foto de tu ticket.`,
        { parse_mode: 'Markdown', ...Markup.keyboard([['📊 Mis facturas', '⚙️ Mi cuenta'], ['❓ Ayuda']]).resize() }
      );
    }
  }
}

// ── Foto = flujo principal (async con cola + fiscal) ─────────────────────────

bot.on('photo', async (ctx) => {
  const userId = String(ctx.from.id);
  const chatId = ctx.chat.id;

  if (!db.isOnboarded(userId)) {
    return ctx.reply('Primero necesito tus datos. Usa /start para registrarte.');
  }

  const userData = db.getUser(userId);
  const foto     = ctx.message.photo[ctx.message.photo.length - 1];
  const fileId   = foto.file_id;

  const msg = await ctx.reply('📸 Recibido. Analizando ticket... ⏳');

  // ── 1. Descargar imagen ──────────────────────────────────────────────────
  let imageBuffer;
  try {
    const fileLink = await bot.telegram.getFileLink(fileId);
    const imgRes   = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
    imageBuffer    = Buffer.from(imgRes.data);
  } catch {
    await bot.telegram.deleteMessage(chatId, msg.message_id).catch(() => {});
    return ctx.reply('❌ No pude descargar la imagen. Intenta de nuevo.');
  }

  // ── 2. OCR — identificar comercio ────────────────────────────────────────
  let ticketData;
  try {
    ticketData = await leerTicket(imageBuffer, 'image/jpeg');
  } catch {
    await bot.telegram.deleteMessage(chatId, msg.message_id).catch(() => {});
    return ctx.reply('❌ No pude leer el ticket. ¿Foto más clara?');
  }

  if (!ticketData || !ticketData.comercio) {
    await bot.telegram.deleteMessage(chatId, msg.message_id).catch(() => {});
    return ctx.reply(
      '❓ No reconocí el tipo de ticket. Por ahora proceso: gasolineras (Petro 7, OXXO Gas), ' +
      '🏪 OXXO tienda, restaurantes Alsea y HEB.'
    );
  }

  // ── 3. Verificar si necesita selección de uso CFDI ───────────────────────
  const usoCfdiCheck = verificarUsoCfdi(ticketData.comercio, userData.regimen, ticketData.categoria);

  if (usoCfdiCheck.necesitaPreguntar) {
    guardarEstadoEsperandoUsoCfdi(userId, ticketData, fileId);
    await bot.telegram.deleteMessage(chatId, msg.message_id).catch(() => {});

    const { text, buttons } = generarBotonesUsoCfdi(
      ticketData.comercio, usoCfdiCheck.opciones, usoCfdiCheck.labels, ticketData.categoria
    );
    return bot.telegram.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: buttons.map(b => [Markup.button.callback(b.text, b.callback_data)]),
      },
    });
  }

  // ── 4. Uso CFDI automático → encolar facturación ─────────────────────────
  ticketData.usoCfdi = usoCfdiCheck.usoCfdi;

  const { position } = enqueue({
    comercio: ticketData.comercio,
    job: async () => {
      const fakeCtx = { from: { id: userId }, telegram: bot.telegram };
      return await handleTicket(fakeCtx, fileId, { ...userData, usoCfdi: ticketData.usoCfdi });
    },
    onComplete: async (resultado) => {
      await bot.telegram.deleteMessage(chatId, msg.message_id).catch(() => {});
      await _enviarResultado(chatId, resultado, ticketData, userData, ticketData.usoCfdi);
    },
    onError: async (err) => {
      await bot.telegram.deleteMessage(chatId, msg.message_id).catch(() => {});
      console.error('[server] Error en cola:', err.message);
      await bot.telegram.sendMessage(chatId, '❌ Error procesando el ticket. Intenta de nuevo.');
    },
  });

  if (position > 0) {
    const ticketId = ticketData.noTicket || ticketData.folio || ticketData.itu || 'n/a';
    const gasto = clasificarGasto(ticketData.comercio, { categoriaVision: ticketData.categoria, ticketId, skipClasificacionLog: true });
    await bot.telegram.editMessageText(
      chatId, msg.message_id, null,
      `${gasto.icon} Recibido. Tu factura de *${gasto.nombre}* está en cola (posición ${position}). Te aviso cuando esté lista. ⏳`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  }
});

// ── Enviar resultado con info fiscal ─────────────────────────────────────────

async function _enviarResultado(chatId, resultado, ticketData, userData, usoCfdi) {
  let msg = resultado.mensajeBot || '✅ Factura procesada.';

  const sendOpts = resultado.ok === true ? { parse_mode: 'Markdown' } : {};
  try {
    await bot.telegram.sendMessage(chatId, msg, sendOpts);
  } catch (err) {
    console.error('[server] sendMessage:', err.message);
    const desc = String(err.response?.description || err.message || '');
    if (/parse entities|can't parse/i.test(desc)) {
      const plain = msg.replace(/\*+/g, '').replace(/_+/g, '').replace(/`/g, '');
      await bot.telegram.sendMessage(chatId, plain).catch((e2) =>
        console.error('[server] sendMessage plain:', e2.message)
      );
    }
  }

  // PDF/XML siempre: antes fallaba todo el bloque si Markdown rompía y no enviaba documentos
  if (resultado.pdfPath && fs.existsSync(resultado.pdfPath)) {
    try {
      await bot.telegram.sendDocument(
        chatId,
        { source: fs.createReadStream(resultado.pdfPath), filename: `factura_${Date.now()}.pdf` },
        { caption: '📄 Tu factura en PDF' }
      );
    } catch (err) {
      console.error('[server] sendDocument PDF:', err.message);
    }
  }
  if (resultado.xmlPath && fs.existsSync(resultado.xmlPath)) {
    try {
      await bot.telegram.sendDocument(
        chatId,
        { source: fs.createReadStream(resultado.xmlPath), filename: `factura_${Date.now()}.xml` },
        { caption: '🗂 Tu factura en XML (CFDI)' }
      );
    } catch (err) {
      console.error('[server] sendDocument XML:', err.message);
    }
  }
}

// ── Menú ──────────────────────────────────────────────────────────────────────

async function handleMisFacturas(ctx) {
  const userId   = String(ctx.from.id);
  const facturas = db.getFacturasMes(userId);
  const user     = db.getUser(userId);
  if (!facturas.length) return ctx.reply('No tienes facturas este mes aún. Mándame un ticket. 📸');

  let totalFacturado = 0, totalDeducible = 0, totalIva = 0;
  facturas.forEach(f => {
    totalFacturado += Number(f.total          || 0);
    totalDeducible += Number(f.montoDeducible || 0);
    totalIva       += Number(f.ivaAcreditable || 0);
  });

  const mes     = new Date().toLocaleString('es-MX', { month: 'long', timeZone: 'America/Mexico_City' });
  const regimen = user?.regimen || '';
  const deduceRegs = ['612','626','601','603','620','622','623','624','625'];

  let msg = `📊 *Facturas de ${mes}*\n\n🧾 Facturas: ${facturas.length}\n💰 Total facturado: $${totalFacturado.toFixed(2)}\n\n`;
  if (deduceRegs.includes(regimen)) {
    msg += `✅ *Deducible ISR:* $${totalDeducible.toFixed(2)}\n💚 *IVA acreditable:* $${totalIva.toFixed(2)}\n\n`;
    msg += `_Estimados según tu régimen ${regimen}. Consulta a tu contador._`;
  } else if (regimen === '605') {
    msg += `ℹ️ Como asalariado, estos gastos no generan deducción propia.\n_Tus CFDIs quedan guardados para referencia._`;
  }
  await ctx.reply(msg, { parse_mode: 'Markdown' });
}

async function handleMiCuenta(ctx) {
  const user = db.getUser(String(ctx.from.id));
  if (!user) return;
  const tipoLabel = user.esMoral ? '🏢 Persona moral' : '👤 Persona física';
  await ctx.reply(
    `⚙️ *Mi cuenta*\n\n${tipoLabel}\n👤 ${user.nombre}\n📋 \`${user.rfc}\`\n📮 CP: ${user.cp}\n📊 Régimen: ${user.regimen}\n📧 ${user.email}\n💳 Plan: ${user.plan || 'free'}`,
    { parse_mode: 'Markdown' }
  );
}

async function handleAyuda(ctx) {
  await ctx.reply(
    '❓ *¿Cómo funciona?*\n\n' +
    '1. Mándame la foto de tu ticket\n' +
    '2. En ~2 minutos tramito tu factura\n' +
    '3. Recibes PDF aquí y XML a tu correo\n\n' +
    '⛽ *Gasolineras:* Petro 7, OXXO Gas\n' +
    '🏪 *Tiendas:* OXXO\n' +
    '🍽️ *Restaurantes:* Starbucks, Domino\'s, BK, Chili\'s y más (Alsea)\n' +
    '🛒 *Supermercados:* HEB\n\n' +
    '⚠️ Solo tickets pagados con *tarjeta*. Efectivo no es deducible ante el SAT.',
    { parse_mode: 'Markdown' }
  );
}

// ── Cron mensual ─────────────────────────────────────────────────────────────

cron.schedule('0 9 1 * *', async () => {
  console.log('[Cron] Enviando resumen mensual...');
  const MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const hoy   = new Date();
  const mesIdx = hoy.getMonth() === 0 ? 11 : hoy.getMonth() - 1;
  const mesNombre = MESES[mesIdx];
  const todos = db.getFacturasMesAnteriorTodos();

  for (const [uid, facturas] of Object.entries(todos)) {
    const user = db.getUser(uid);
    if (!user) continue;
    let totalFacturado = 0, totalDeducible = 0, totalIva = 0;
    facturas.forEach(f => {
      totalFacturado += Number(f.total || 0);
      totalDeducible += Number(f.montoDeducible || 0);
      totalIva       += Number(f.ivaAcreditable || 0);
    });
    const nombre  = user.nombre.split(' ')[0];
    const regimen = user.regimen || '';
    const deduceRegs = ['612','626','601','603','620','622','623','624','625'];

    let msg = `📅 *Resumen fiscal de ${mesNombre}*\n\nHola ${nombre}:\n\n🧾 Facturas: ${facturas.length}\n💰 Total: $${totalFacturado.toFixed(2)}\n\n`;
    if (deduceRegs.includes(regimen)) {
      msg += `✅ *Deducible ISR:* $${totalDeducible.toFixed(2)}\n💚 *IVA acreditable:* $${totalIva.toFixed(2)}\n\n_Tu contador determina el monto final._\n\n`;
    } else if (regimen === '605') {
      msg += `ℹ️ Como asalariado, tus CFDIs quedan registrados.\n\n`;
    }
    msg += `📸 Mándame tus tickets este mes para seguir acumulando.`;
    try { await bot.telegram.sendMessage(uid, msg, { parse_mode: 'Markdown' }); } catch {}
  }
}, { timezone: 'America/Mexico_City' });

// ── Arrancar ──────────────────────────────────────────────────────────────────

if (process.env.WEBHOOK_URL) {
  // Modo webhook (Railway / producción)
  app.post(
    '/webhooks/email',
    express.json({ limit: '50mb' }),
    createEmailInboundHandler(bot, db)
  );
  app.use(express.json());
  app.use(bot.webhookCallback('/webhook'));
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, async () => {
    await bot.telegram.setWebhook(`${process.env.WEBHOOK_URL}/webhook`);
    console.log(`[Cotas] Modo webhook en puerto ${PORT} — ${new Date().toISOString()}`);
  });
} else {
  // Modo polling (desarrollo local)
  bot.telegram.deleteWebhook({ drop_pending_updates: true }).then(async () => {
    await bot.launch();
    isPollingActive = true;
    console.log('[Cotas] Modo polling');
  }).catch((err) => {
    console.error('[Cotas] Error al arrancar polling:', err.message);
    process.exit(1);
  });
}

function gracefulStop(signal) {
  try {
    // Webhook: no hubo `launch()` → `stop()` lanzaría "Bot is not running!".
    if (typeof isPollingActive !== 'undefined' && !isPollingActive) return;
    bot.stop(signal);
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes('not running')) return;
    console.warn(`[Cotas] Error al detener bot (${signal}): ${msg}`);
  }
}

process.once('SIGINT',  () => gracefulStop('SIGINT'));
process.once('SIGTERM', () => gracefulStop('SIGTERM'));
