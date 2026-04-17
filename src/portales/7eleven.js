/**
 * src/portales/7eleven.js — Adaptador HTTP para 7-Eleven México
 * 
 * API REST puro con axios. Auth: Basic estática (hardcodeada en el JS del portal).
 * Captcha: Kaptcha.jpg → Claude Vision (Haiku), validación session-based.
 * 
 * Descubierto via DevTools → Copy as cURL: authorization: Basic a2V4d...
 * Sin Playwright. Sin registro. Factura Express.
 * 
 * RFC Emisor: SEM980701STA (7-ELEVEN MEXICO SA DE CV)
 */

const axios = require('axios');

const BASE = 'https://www.e7-eleven.com.mx';
const API  = `${BASE}/KJServices/webapi`;
const AUTH = 'Basic a2V4dHdlYmFwaTprbGkkS0wtM1c=';  // kextwebapi:kli$KL-3W

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// ============================================================
// SESIÓN HTTP CON AUTH + COOKIES (para captcha session)
// ============================================================
function crearSesion() {
  const cookies = {};

  const session = axios.create({
    baseURL: BASE,
    timeout: 15000,
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Authorization': AUTH,
      'Referer': `${BASE}/facturacion/KPortalExterno/`,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    },
  });

  // Guardar cookies de respuestas (necesario para captcha session)
  session.interceptors.response.use(resp => {
    const sc = resp.headers['set-cookie'];
    if (sc) {
      for (const c of (Array.isArray(sc) ? sc : [sc])) {
        const [pair] = c.split(';');
        const [name, val] = pair.split('=');
        if (name && val) cookies[name.trim()] = val.trim();
      }
    }
    return resp;
  });

  // Enviar cookies en cada request
  session.interceptors.request.use(config => {
    const str = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    if (str) config.headers['Cookie'] = str;
    return config;
  });

  return session;
}

// ============================================================
// CAPTCHA — Claude Vision (Haiku)
// ============================================================
async function resolverCaptchaVision(imgBuffer) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY no configurada');

  const resp = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 50,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imgBuffer.toString('base64') } },
        { type: 'text', text: 'Lee el texto del captcha en esta imagen. Responde SOLO con los caracteres exactos, sin explicación, sin comillas, sin espacios. Son letras minúsculas y/o números.' },
      ],
    }],
  }, {
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    timeout: 10000,
  });

  return resp.data.content[0].text.trim().toLowerCase();
}

async function resolverCaptchaConRetry(session, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      // Cada GET genera nueva imagen (session-based)
      const { data: imgBuffer } = await session.get('/KPortalExterno/Kaptcha.jpg', {
        responseType: 'arraybuffer',
      });

      if (!imgBuffer || imgBuffer.length < 500) {
        console.log(`[7-Eleven] Captcha vacío (${imgBuffer?.length || 0}b), retry...`);
        continue;
      }

      const texto = await resolverCaptchaVision(Buffer.from(imgBuffer));
      console.log(`[7-Eleven] Captcha intento ${i + 1}: "${texto}"`);

      const { data: val } = await session.get('/KPortalExterno/kaptcha', {
        params: { kaptcha: texto },
      });

      if (val.esValido) {
        console.log('[7-Eleven] Captcha ✅');
        return texto;
      }
      console.log(`[7-Eleven] Captcha rechazado: ${val.mensaje}`);
    } catch (err) {
      console.error(`[7-Eleven] Captcha error intento ${i + 1}: ${err.message}`);
    }
  }
  throw new Error('Captcha no resuelto después de 3 intentos');
}

// ============================================================
// FLUJO PRINCIPAL
// ============================================================
async function facturar7Eleven(ticket, fiscal) {
  const { noTicket } = ticket;
  const { rfc, nombre, cp, regimen, email, usoCFDI = 'G03' } = fiscal;

  console.log(`[7-Eleven] Facturando ticket ${noTicket.substring(0, 8)}...`);
  const session = crearSesion();

  try {
    // ── 1. Inicializar sesión (obtener cookies) ──
    await session.get('/facturacion/KPortalExterno/', {
      headers: { 'Accept': 'text/html' },
    });
    console.log('[7-Eleven] Sesión iniciada');

    // ── 2. Validar ticket ──
    console.log('[7-Eleven] Validando ticket...');
    const { data: tv } = await session.get(`${API}/FacturacionService/verificaTicketWS2`, {
      params: { noTicket },
    });

    if (tv.status !== '0') {
      const msgs = {
        '1': 'Este ticket ya fue facturado anteriormente.',
        '2': 'Ticket no encontrado. Verifica el número.',
        '3': 'Ticket vencido. Solo se puede facturar dentro del mes + 5 días.',
      };
      return { success: false, error: msgs[tv.status] || tv.mensajeValidacion || `Error (status ${tv.status})` };
    }

    console.log(`[7-Eleven] Ticket válido: tienda=${tv.estacion} $${tv.totalTicket} pago=${tv.formaPago}`);

    // ── 3. Resolver captcha ──
    await resolverCaptchaConRetry(session, 3);

    // ── 4. Generar CFDI ──
    console.log('[7-Eleven] Generando CFDI...');
    const ticketsJson = JSON.stringify([{
      noEstacion: tv.estacion,
      noTicket,
      monto: tv.totalTicket,
      formaPago: tv.formaPago,
      id: null,
    }]);

    const body = new URLSearchParams({
      rfc, razon: nombre, cp,
      regimenFiscalReceptor: regimen,
      usoCFDI, email,
      selectedFormaPago: tv.formaPago,
      tickets: ticketsJson,
      facturaExpress: 'true',
      facturaRegistrado: 'true',
      idCliente: '-1',
      medioEmision: 'FEXPRESS',
      calle: '', ciudad: '', colonia: '', delegacion: '',
      noExterior: '', noInterior: '', pais: '',
    });

    const { data: facturaResp } = await session.post(`${API}/FacturaExpressService`, body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const r = Array.isArray(facturaResp) ? facturaResp[0] : facturaResp;
    if (!r.cfdiDisponible) {
      return { success: false, error: r.respuesta || 'CFDI no generado' };
    }

    const uuid = r.uuid;
    console.log(`[7-Eleven] CFDI generado: ${uuid}`);

    // ── 5. Descargar PDF ──
    const { data: pdfResp } = await session.get(`${API}/FacturaExpressService/descargaCfdiPdf`, {
      params: { uuid },
    });

    // ── 6. Descargar XML ──
    const { data: xmlResp } = await session.get(`${API}/FacturaExpressService/descargaCfdiXml`, {
      params: { email, uuid },
    });

    console.log(`[7-Eleven] ✅ $${tv.totalTicket} folio=${xmlResp.folio}`);

    return {
      success: true,
      b64Pdf: pdfResp.b64Pdf,
      xml: xmlResp.xml || xmlResp.interpretado,
      uuid,
      total: parseFloat(tv.totalTicket),
      folio: xmlResp.folio,
      serie: xmlResp.serie,
    };

  } catch (err) {
    const status = err.response?.status;
    console.error(`[7-Eleven] ❌ ${err.message} (status=${status})`);

    if (status === 502 || status === 503) {
      return { success: false, error: 'Portal de 7-Eleven no disponible.' };
    }
    return { success: false, error: err.message };
  }
}

// ============================================================
// PARSEO DE TICKET
// ============================================================
function parsearTicket7Eleven(ocrText) {
  const match = ocrText.match(/(\d{30,40})/);
  return match ? match[1] : null;
}

module.exports = { facturar7Eleven, parsearTicket7Eleven };
