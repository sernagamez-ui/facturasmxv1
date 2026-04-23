// src/webhooks/emailInbound.js
//
// Endpoint HTTP que recibe emails reenviados por el Cloudflare Email Worker
// (factural-inbound). Extrae XML/PDF de los CFDIs y los envía al chat de
// Telegram según telegram_id del payload.
//
// Flujo:
//   Portal → factural.mx → Cloudflare Email Routing → Email Worker → POST aquí
//   → parsear MIME → extraer adjuntos → bot.telegram.sendDocument() → DB

'use strict';

const { simpleParser } = require('mailparser');
const { calcularDeducibilidad } = require('../fiscalRules');

const log = (...a) => console.log('[emailInbound]', ...a);
const logErr = (...a) => console.error('[emailInbound]', ...a);

function detectarComercioSlug(from, subject) {
  const texto = `${from || ''} ${subject || ''}`.toLowerCase();
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

/** Nombre legible para caption (heurística). */
function detectarPortal(from, subject) {
  const s = `${from || ''} ${subject || ''}`.toLowerCase();
  if (s.includes('officedepot')) return 'Office Depot';
  if (s.includes('petro7') || s.includes('7-eleven')) return 'Petro7';
  if (s.includes('oxxo')) return 'OXXO Gas';
  if (s.includes('homedepot')) return 'Home Depot';
  if (s.includes('walmart')) return 'Walmart';
  return null;
}

function extraerMonto(subject, textBody) {
  const texto = `${subject || ''} ${textBody || ''}`;
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

/** @param {object} bot - instancia Telegraf (telegram.sendDocument, etc.) */
function createEmailInboundHandler(bot, db) {
  return async function emailInboundHandler(req, res) {
    try {
      const expected = process.env.WEBHOOK_SECRET;
      const providedSecret = req.header('X-Webhook-Secret');
      if (!expected || providedSecret !== expected) {
        logErr('Secret inválido o WEBHOOK_SECRET no configurado');
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const { from, to, telegramId, rawBase64, rawSize, receivedAt } = req.body || {};

      if (!telegramId || !rawBase64) {
        logErr('Payload incompleto:', { hasTid: !!telegramId, hasRaw: !!rawBase64 });
        return res.status(400).json({ error: 'Payload incompleto' });
      }

      log(`start from=${from} to=${to} tgid=${telegramId} size=${rawSize}`);

      let parsed;
      try {
        const rawBuffer = Buffer.from(rawBase64, 'base64');
        parsed = await simpleParser(rawBuffer);
      } catch (err) {
        logErr(`parse MIME failed: ${err.message}`);
        return res.status(200).json({ ok: false, reason: 'parse_failed' });
      }

      const attachments = parsed.attachments || [];
      const xml = attachments.find(
        (a) =>
          (a.contentType && String(a.contentType).toLowerCase().includes('xml')) ||
          (a.filename && String(a.filename).toLowerCase().endsWith('.xml'))
      );
      const pdf = attachments.find(
        (a) =>
          (a.contentType && String(a.contentType).toLowerCase().includes('pdf')) ||
          (a.filename && String(a.filename).toLowerCase().endsWith('.pdf'))
      );

      if (!xml && !pdf) {
        logErr(
          `sin adjuntos CFDI. attachments=${attachments.length}. from=${from} subject="${parsed.subject}"`
        );
        try {
          await bot.telegram.sendMessage(
            telegramId,
            `📧 Llegó un correo a tu alias de facturación pero no incluye un CFDI (XML/PDF).\n\n` +
              `De: ${from}\nAsunto: ${parsed.subject || '(sin asunto)'}\n\n` +
              `Si esperabas una factura, revisa tu correo personal o contacta al portal.`
          );
        } catch (err) {
          logErr(`notificar sin-adjuntos falló: ${err.message}`);
          return res.status(500).json({ error: 'telegram_send_failed' });
        }
        return res.status(200).json({ ok: true, reason: 'no_attachments' });
      }

      const uuid = xml?.content ? extraerUuidDeXml(xml.content) : null;
      if (uuid) {
        const recientes = db.getFacturasMes(telegramId);
        const uuidLower = uuid.toLowerCase();
        if (recientes.some((f) => String(f.uuid || '').toLowerCase() === uuidLower)) {
          log(`UUID ${uuid} ya en historial del usuario — omitiendo envío`);
          return res.status(200).json({ ok: true, reason: 'duplicate_uuid' });
        }
      }

      const chatId = Number(telegramId);
      const portalLabel = detectarPortal(from, parsed.subject || '');
      const caption = `✅ Factura recibida${portalLabel ? ` de ${portalLabel}` : ''}.`;

      try {
        if (pdf) {
          await bot.telegram.sendDocument(
            chatId,
            { source: pdf.content, filename: pdf.filename || 'factura.pdf' },
            { caption }
          );
        }
        if (xml) {
          await bot.telegram.sendDocument(
            chatId,
            { source: xml.content, filename: xml.filename || 'factura.xml' },
            pdf ? {} : { caption }
          );
        }
        log(`entregado tgid=${telegramId} xml=${!!xml} pdf=${!!pdf}`);
      } catch (err) {
        logErr(`Telegram send failed tgid=${telegramId}: ${err.message}`);
        return res.status(500).json({ error: 'telegram_send_failed' });
      }

      const comercio = detectarComercioSlug(from, parsed.subject || '');
      const total = extraerMonto(parsed.subject || '', parsed.text || '');
      const userData = db.getUser(telegramId);
      const montoTotal = total != null && Number.isFinite(total) ? total : 0;

      try {
        let fac = {
          portal: comercio,
          comercio,
          monto: montoTotal,
          total: montoTotal,
          uuid,
          nota_negocio: null,
          origen: 'email-webhook',
          fecha: receivedAt || new Date().toISOString(),
          fromEmail: from,
          subject: parsed.subject,
          hasXml: !!xml,
          hasPdf: !!pdf,
          xmlFilename: xml?.filename,
          pdfFilename: pdf?.filename,
          metodoPago: 'tarjeta',
        };

        if (userData) {
          const deduccion = calcularDeducibilidad({
            comercio,
            total: montoTotal || 0,
            regimen: userData.regimen,
            metodoPago: 'tarjeta',
            usoCfdi: userData.usoCFDI || userData.usoCfdi || 'G03',
          });
          const montoDeducible = Number(deduccion.montoDeducible) || 0;
          const ivaAcreditable = Number(deduccion.ivaAcreditable) || 0;
          fac = {
            ...fac,
            regimen: userData.regimen,
            deducible: deduccion.deducible,
            deducibleISR: montoDeducible,
            montoDeducible,
            ivaAcreditable,
          };
        }

        db.guardarFactura(telegramId, fac);
      } catch (err) {
        logErr(`DB save failed: ${err.message}`);
      }

      return res.status(200).json({ ok: true });
    } catch (err) {
      logErr(`unhandled: ${err?.message || err}`);
      return res.status(200).json({ ok: false, reason: 'internal_error' });
    }
  };
}

module.exports = { createEmailInboundHandler };
