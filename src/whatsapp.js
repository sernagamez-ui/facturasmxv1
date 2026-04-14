/**
 * whatsapp.js — Envío de mensajes vía WhatsApp Cloud API
 *
 * ⚠️ BUG CONOCIDO RESUELTO:
 * Los números mexicanos llegan del webhook como 521XXXXXXXXXX (13 dígitos).
 * La API de Meta requiere 52XXXXXXXXXX (12 dígitos).
 * cleanPhone() normaliza esto automáticamente.
 */

const axios = require('axios');

const BASE_URL = `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_ID}/messages`;

const headers = () => ({
  Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
  'Content-Type': 'application/json',
});

/**
 * Normaliza número mexicano de WhatsApp.
 * 521XXXXXXXXXX (13 dígitos) → 52XXXXXXXXXX (12 dígitos)
 */
function cleanPhone(phone) {
  const p = String(phone).replace(/\D/g, '');
  if (p.startsWith('521') && p.length === 13) return '52' + p.slice(3);
  return p;
}

async function sendText(to, message) {
  const phone = cleanPhone(to);
  try {
    await axios.post(BASE_URL, {
      messaging_product: 'whatsapp',
      to: phone,
      type: 'text',
      text: { body: message },
    }, { headers: headers() });
  } catch (err) {
    console.error('[WA] Error enviando texto:', err.response?.data || err.message);
  }
}

async function sendImage(to, imageUrl, caption = '') {
  const phone = cleanPhone(to);
  try {
    await axios.post(BASE_URL, {
      messaging_product: 'whatsapp',
      to: phone,
      type: 'image',
      image: { link: imageUrl, caption },
    }, { headers: headers() });
  } catch (err) {
    console.error('[WA] Error enviando imagen:', err.response?.data || err.message);
  }
}

async function sendDocument(to, documentUrl, filename, caption = '') {
  const phone = cleanPhone(to);
  try {
    await axios.post(BASE_URL, {
      messaging_product: 'whatsapp',
      to: phone,
      type: 'document',
      document: { link: documentUrl, filename, caption },
    }, { headers: headers() });
  } catch (err) {
    console.error('[WA] Error enviando documento:', err.response?.data || err.message);
  }
}

async function markRead(messageId) {
  try {
    await axios.post(BASE_URL, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    }, { headers: headers() });
  } catch {
    // No crítico
  }
}

/**
 * Descarga un archivo multimedia de WhatsApp (imagen de ticket).
 * Retorna buffer con los bytes.
 */
async function downloadMedia(mediaId) {
  try {
    // 1. Obtener URL del media
    const { data } = await axios.get(
      `https://graph.facebook.com/v19.0/${mediaId}`,
      { headers: headers() }
    );
    // 2. Descargar el archivo
    const response = await axios.get(data.url, {
      headers: headers(),
      responseType: 'arraybuffer',
    });
    return {
      buffer: Buffer.from(response.data),
      mimeType: data.mime_type || 'image/jpeg',
    };
  } catch (err) {
    console.error('[WA] Error descargando media:', err.response?.data || err.message);
    return null;
  }
}

module.exports = { sendText, sendImage, sendDocument, markRead, downloadMedia, cleanPhone };
