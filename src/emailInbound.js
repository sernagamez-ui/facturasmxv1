/**
 * src/emailInbound.js — Lector IMAP del buzón que recibe reenvíos *@factural.mx
 *
 * Cloudflare Email Routing puede entregar en Gmail (ej. factural.beta@gmail.com).
 * Cada usuario usa {telegram_id}@factural.mx; aquí se identifica y se reenvían
 * XML/PDF por Telegram (Resend al correo personal ya está en mailer).
 *
 * Requiere: IMAP_USER, IMAP_PASS (App Password en Gmail)
 * Opcional: IMAP_HOST (default imap.gmail.com), IMAP_PORT (993), INBOUND_CRON
 */

'use strict';

const cron = require('node-cron');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const path = require('path');
const os = require('os');
const fs = require('fs');

const db = require('./db');
const { enviarFactura, formatearNombreComercio } = require('./mailer');
const { calcularDeducibilidad } = require('./fiscalRules');

let _bot = null;

function imapConfig() {
  if (!process.env.IMAP_USER || !process.env.IMAP_PASS) {
    throw new Error('[emailInbound] Faltan IMAP_USER e IMAP_PASS en variables de entorno');
  }
  return {
    host: process.env.IMAP_HOST || 'imap.gmail.com',
    port: Number(process.env.IMAP_PORT) || 993,
    secure: true,
    auth: {
      user: process.env.IMAP_USER,
      pass: process.env.IMAP_PASS,
    },
    logger: false,
  };
}

function telegramIdDesdeTexto(texto) {
  if (!texto) return null;
  const m = String(texto).match(/(\d{6,})@factural\.mx/i);
  return m ? m[1] : null;
}

/**
 * Localiza telegram_id en To/Cc, Delivered-To o X-Original-To (útil si el reenvío altera cabeceras).
 */
function extraerTelegramId(parsed) {
  const seen = new Set();
  const tryText = (t) => {
    const id = telegramIdDesdeTexto(t);
    if (id && !seen.has(id)) {
      seen.add(id);
      return id;
    }
    return null;
  };

  const fromAddressObjects = (obj) => {
    if (!obj) return [];
    const arr = obj.value || (Array.isArray(obj) ? obj : []);
    return arr.map((a) => a.address || a.text || '').filter(Boolean);
  };

  for (const addr of fromAddressObjects(parsed.to)) {
    const id = tryText(addr);
    if (id) return id;
  }
  for (const addr of fromAddressObjects(parsed.cc)) {
    const id = tryText(addr);
    if (id) return id;
  }

  const h = parsed.headers;
  if (h && typeof h.get === 'function') {
    for (const key of ['delivered-to', 'x-original-to', 'envelope-to', 'x-forwarded-to']) {
      const raw = h.get(key);
      if (raw) {
        const id = tryText(raw);
        if (id) return id;
      }
    }
  }

  return null;
}

function detectarComercio(from, subject) {
  const texto = `${from} ${subject}`.toLowerCase();
  if (texto.includes('home depot') || texto.includes('homedepot')) return 'homedepot';
  if (texto.includes('office depot') || texto.includes('officedepot')) return 'officedepot';
  if (texto.includes('officemax')) return 'officemax';
  if (texto.includes('walmart')) return 'walmart';
  if (texto.includes('heb')) return 'heb';
  if (texto.includes('7-eleven') || texto.includes('seven eleven')) return '7eleven';
  if (texto.includes('petro')) return 'petro7';
  if (texto.includes('oxxo')) return 'oxxogas';
  if (texto.includes('starbucks')) return 'starbucks';
  if (texto.includes('domino')) return 'dominos';
  if (texto.includes('mcdonald')) return 'mcdonalds';
  if (texto.includes('sodimac')) return 'sodimac';
  if (texto.includes('liverpool')) return 'liverpool';
  if (texto.includes('chedraui')) return 'chedraui';
  return 'desconocido';
}

function extraerMonto(subject, textBody) {
  const texto = `${subject} ${textBody || ''}`;
  const match = texto.match(/\$\s?([\d,]+(?:\.\d{2})?)/);
  if (match) return parseFloat(match[1].replace(/,/g, ''));
  return null;
}

function extraerUuidDeXml(xmlBuffer) {
  try {
    const xml = xmlBuffer.toString('utf8');
    const match = xml.match(/UUID="([a-f0-9-]{36})"/i);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

async function procesarEmail(parsed) {
  const telegramId = extraerTelegramId(parsed);
  if (!telegramId) {
    const hint = parsed.to?.text || parsed.headers?.get?.('delivered-to') || '(sin destino)';
    console.log(`[emailInbound] Sin telegram_id@factural.mx en destinatarios: ${hint}`);
    return;
  }

  const userData = db.getUser(telegramId);
  if (!userData) {
    console.log(`[emailInbound] Usuario ${telegramId} no encontrado en DB`);
    return;
  }

  const adjuntos = parsed.attachments || [];
  let xmlBuffer = null;
  let pdfBuffer = null;
  let xmlFilename = null;
  let pdfFilename = null;

  for (const adj of adjuntos) {
    const name = (adj.filename || '').toLowerCase();
    if (name.endsWith('.xml') && !xmlBuffer) {
      xmlBuffer = adj.content;
      xmlFilename = adj.filename;
    }
    if (name.endsWith('.pdf') && !pdfBuffer) {
      pdfBuffer = adj.content;
      pdfFilename = adj.filename;
    }
  }

  if (!xmlBuffer && !pdfBuffer) {
    console.log(
      `[emailInbound] Email sin adjuntos XML/PDF — from: ${parsed.from?.text} subject: ${parsed.subject}`
    );
    return;
  }

  const comercio = detectarComercio(parsed.from?.text || '', parsed.subject || '');
  const uuid = xmlBuffer ? extraerUuidDeXml(xmlBuffer) : null;
  const total = extraerMonto(parsed.subject || '', parsed.text || '');

  if (uuid) {
    const recientes = db.getFacturasMes(telegramId);
    const uuidLower = uuid.toLowerCase();
    if (recientes.some((f) => String(f.uuid || '').toLowerCase() === uuidLower)) {
      console.log(`[emailInbound] UUID ${uuid} ya en historial del usuario — omitiendo`);
      return;
    }
  }

  console.log(
    `[emailInbound] Factura | usuario=${telegramId} | comercio=${comercio} | uuid=${uuid || 'n/a'} | total=${total ?? 'n/a'}`
  );

  const outputDir = path.join(os.tmpdir(), 'factural', telegramId, Date.now().toString());
  fs.mkdirSync(outputDir, { recursive: true });

  let xmlPath = null;
  let pdfPath = null;

  if (xmlBuffer) {
    xmlPath = path.join(outputDir, xmlFilename || `factura_${uuid || Date.now()}.xml`);
    fs.writeFileSync(xmlPath, xmlBuffer);
  }
  if (pdfBuffer) {
    pdfPath = path.join(outputDir, pdfFilename || `factura_${uuid || Date.now()}.pdf`);
    fs.writeFileSync(pdfPath, pdfBuffer);
  }

  if (_bot) {
    try {
      const nombreComercio = formatearNombreComercio(comercio);
      const montoStr = total != null ? ` · $${total.toFixed(2)} MXN` : '';
      await _bot.telegram.sendMessage(
        telegramId,
        `📨 *Nueva factura recibida*\n\n🏪 ${nombreComercio}${montoStr}\n${uuid ? `🔖 UUID: \`${uuid}\`` : ''}\n\n📎 Archivos adjuntos:`,
        { parse_mode: 'Markdown' }
      );

      if (pdfPath && fs.existsSync(pdfPath)) {
        await _bot.telegram.sendDocument(
          telegramId,
          { source: pdfPath, filename: pdfFilename || `factura_${comercio}.pdf` },
          { caption: '📄 PDF' }
        );
      }
      if (xmlPath && fs.existsSync(xmlPath)) {
        await _bot.telegram.sendDocument(
          telegramId,
          { source: xmlPath, filename: xmlFilename || `factura_${comercio}.xml` },
          { caption: '🗂 XML' }
        );
      }
    } catch (err) {
      console.warn(`[emailInbound] Error enviando por Telegram a ${telegramId}:`, err.message);
    }
  }

  if (userData.email) {
    await enviarFactura({
      email: userData.email,
      comercio,
      total,
      uuid,
      xmlBuffer,
      pdfBuffer,
    }).catch((e) => console.warn('[emailInbound] Error reenvío email:', e.message));
  }

  const montoTotal = total != null && Number.isFinite(total) ? total : 0;
  const deduccion = calcularDeducibilidad({
    comercio,
    total: montoTotal || 0,
    regimen: userData.regimen,
    metodoPago: 'tarjeta',
    usoCfdi: userData.usoCFDI || userData.usoCfdi || 'G03',
  });
  const montoDeducible = Number(deduccion.montoDeducible) || 0;
  const ivaAcreditable = Number(deduccion.ivaAcreditable) || 0;

  db.guardarFactura(telegramId, {
    portal: comercio,
    comercio,
    monto: montoTotal,
    total: montoTotal,
    uuid,
    origen: 'email_inbound',
    fecha: new Date().toISOString(),
    regimen: userData.regimen,
    deducible: deduccion.deducible,
    deducibleISR: montoDeducible,
    montoDeducible,
    ivaAcreditable,
    metodoPago: 'tarjeta',
  });

  try {
    fs.rmSync(outputDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

async function leerBuzon() {
  let client;
  try {
    client = new ImapFlow(imapConfig());
    await client.connect();
    await client.mailboxOpen('INBOX');

    const mensajes = await client.search({ seen: false });
    if (!mensajes || mensajes.length === 0) {
      await client.logout();
      return;
    }

    console.log(`[emailInbound] ${mensajes.length} email(s) nuevos`);

    for await (const msg of client.fetch(mensajes, { source: true })) {
      try {
        const parsed = await simpleParser(msg.source);
        await procesarEmail(parsed);
        await client.messageFlagsAdd(msg.seq, ['\\Seen']);
      } catch (err) {
        console.error(`[emailInbound] Error procesando mensaje seq=${msg.seq}:`, err.message);
      }
    }

    await client.logout();
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes('IMAP_USER') || msg.includes('IMAP_PASS')) return;
    console.error('[emailInbound] Error IMAP:', msg);
    try {
      await client?.logout();
    } catch {
      /* ignore */
    }
  }
}

function initEmailInbound(botInstance) {
  if (!process.env.IMAP_USER || !process.env.IMAP_PASS) {
    console.log('[emailInbound] IMAP no configurado — módulo desactivado (IMAP_USER / IMAP_PASS)');
    return;
  }

  _bot = botInstance;

  const cronExpr = process.env.INBOUND_CRON || '*/2 * * * *';
  cron.schedule(cronExpr, () => {
    leerBuzon().catch((e) => console.error('[emailInbound] Cron error:', e.message));
  });

  console.log(`[emailInbound] Activo — ${cronExpr} | ${process.env.IMAP_USER}`);

  leerBuzon().catch((e) => console.error('[emailInbound] Primera lectura:', e.message));
}

module.exports = { initEmailInbound };
