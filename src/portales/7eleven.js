/**
 * src/portales/7eleven.js — Adaptador HTTP para 7-Eleven México
 * 
 * Modelo A: Sin registro. Factura Express vía REST API puro (axios).
 * Captcha: Kaptcha.jpg resuelto con Claude Vision (Haiku).
 * 
 * Selectores y endpoints confirmados con test_7eleven.js (2026-04-14).
 * 
 * Endpoints confirmados:
 *   GET  /KPortalExterno/Kaptcha.jpg                          → imagen captcha (200x50)
 *   GET  /KPortalExterno/kaptcha?kaptcha={texto}              → valida captcha
 *   GET  /KJServices/webapi/FacturacionService/verificaTicketWS2?noTicket=  → valida ticket
 *   POST /KJServices/webapi/FacturaExpressService              → genera CFDI
 *   GET  /KJServices/webapi/FacturaExpressService/descargaCfdiPdf?uuid=     → PDF base64
 *   GET  /KJServices/webapi/FacturaExpressService/descargaCfdiXml?email=&uuid= → XML
 * 
 * RFC Emisor: SEM980701STA (7-ELEVEN MEXICO SA DE CV)
 * Cobertura: ~2,000+ tiendas
 */

const axios = require('axios');

const BASE = 'https://www.e7-eleven.com.mx';
const API  = `${BASE}/KJServices/webapi`;

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// ============================================================
// SESIÓN HTTP CON COOKIES
// ============================================================
function crearSesion() {
  const cookies = {};
  
  const session = axios.create({
    baseURL: BASE,
    timeout: 15000,
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Referer': `${BASE}/facturacion/KPortalExterno/`,
    },
  });

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
async function resolverCaptcha(imgBuffer) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY no configurada en .env');

  const resp = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 50,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imgBuffer.toString('base64') } },
        { type: 'text', text: 'Lee el texto del captcha en esta imagen. Responde SOLO con los caracteres exactos, sin explicación, sin comillas, sin espacios extra. Son letras minúsculas y/o números.' },
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

/**
 * Descarga imagen captcha, la resuelve con Vision, y la valida con el server.
 * Reintenta hasta maxRetries veces (cada retry genera nueva imagen).
 */
async function resolverCaptchaConRetry(session, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      // Descargar imagen — Kaptcha.jpg (K mayúscula, confirmado)
      // Cada GET genera una nueva imagen (session-based)
      const { data: imgBuffer } = await session.get('/KPortalExterno/Kaptcha.jpg', {
        responseType: 'arraybuffer',
      });

      if (!imgBuffer || imgBuffer.length < 500) {
        console.log(`[7-Eleven] Captcha imagen vacía (${imgBuffer?.length || 0} bytes), reintentando...`);
        continue;
      }

      const texto = await resolverCaptcha(Buffer.from(imgBuffer));
      console.log(`[7-Eleven] Captcha intento ${i + 1}: "${texto}"`);

      // Validar con el server
      const { data: validacion } = await session.get('/KPortalExterno/kaptcha', {
        params: { kaptcha: texto },
      });

      if (validacion.esValido) {
        console.log('[7-Eleven] Captcha validado ✅');
        return texto;
      }

      console.log(`[7-Eleven] Captcha rechazado: ${validacion.mensaje}`);
    } catch (err) {
      console.error(`[7-Eleven] Error captcha intento ${i + 1}: ${err.message}`);
    }
  }

  throw new Error(`Captcha no resuelto después de ${maxRetries} intentos`);
}

// ============================================================
// FLUJO PRINCIPAL
// ============================================================

/**
 * Genera factura de 7-Eleven.
 * 
 * @param {Object} ticket
 * @param {string} ticket.noTicket - Número bajo código de barras (35 dígitos)
 * @param {Object} fiscal - Datos fiscales del usuario (del onboarding)
 * @param {string} fiscal.rfc
 * @param {string} fiscal.nombre - Razón social completa (mayúsculas)
 * @param {string} fiscal.cp - Código postal fiscal
 * @param {string} fiscal.regimen - Código régimen (601, 605, 606, 612, 616, 620, 625, 626)
 * @param {string} fiscal.email
 * @param {string} [fiscal.usoCFDI='G03'] - Uso del CFDI
 * @returns {Object} { success, b64Pdf, xml, uuid, total, folio, error }
 */
async function facturar7Eleven(ticket, fiscal) {
  const { noTicket } = ticket;
  const { rfc, nombre, cp, regimen, email, usoCFDI = 'G03' } = fiscal;

  console.log(`[7-Eleven] Facturando ticket ${noTicket.substring(0, 8)}...`);

  const session = crearSesion();

  try {
    // ── 1. Obtener sesión (cookies) ──
    await session.get('/facturacion/KPortalExterno/');
    console.log('[7-Eleven] Sesión iniciada');

    // ── 2. Validar ticket ──
    const { data: tv } = await session.get(
      `${API}/FacturacionService/verificaTicketWS2`,
      { params: { noTicket } }
    );

    if (tv.status !== '0') {
      const msgs = {
        '1': 'Este ticket ya fue facturado anteriormente.',
        '2': 'Ticket no encontrado. Verifica el número.',
        '3': 'Ticket vencido. Solo se puede facturar dentro del mes + 5 días.',
      };
      return { success: false, error: msgs[tv.status] || tv.mensajeValidacion || `Error validando ticket (status ${tv.status})` };
    }

    console.log(`[7-Eleven] Ticket válido: tienda=${tv.estacion} total=$${tv.totalTicket} pago=${tv.formaPago}`);

    // ── 3. Resolver captcha ──
    await resolverCaptchaConRetry(session, 3);

    // ── 4. Generar CFDI ──
    console.log('[7-Eleven] Generando CFDI...');

    const ticketsPayload = JSON.stringify([{
      noEstacion: tv.estacion,
      noTicket,
      monto: tv.totalTicket,
      formaPago: tv.formaPago,
      id: null,
    }]);

    const body = new URLSearchParams({
      rfc,
      razon: nombre,
      cp,
      regimenFiscalReceptor: regimen,
      usoCFDI,
      email,
      selectedFormaPago: tv.formaPago,
      tickets: ticketsPayload,
      facturaExpress: 'true',
      facturaRegistrado: 'true',
      idCliente: '-1',
      medioEmision: 'FEXPRESS',
      calle: '', ciudad: '', colonia: '', delegacion: '',
      noExterior: '', noInterior: '', pais: '',
    });

    const { data: facturaResp } = await session.post(
      `${API}/FacturaExpressService`,
      body.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const r = Array.isArray(facturaResp) ? facturaResp[0] : facturaResp;

    if (!r.cfdiDisponible) {
      return { success: false, error: r.respuesta || 'CFDI no generado' };
    }

    const uuid = r.uuid;
    console.log(`[7-Eleven] CFDI generado: ${uuid}`);

    // ── 5. Descargar PDF ──
    const { data: pdfResp } = await session.get(
      `${API}/FacturaExpressService/descargaCfdiPdf`,
      { params: { uuid } }
    );

    // ── 6. Descargar XML ──
    const { data: xmlResp } = await session.get(
      `${API}/FacturaExpressService/descargaCfdiXml`,
      { params: { email, uuid } }
    );

    console.log(`[7-Eleven] ✅ Factura lista: $${tv.totalTicket} folio=${xmlResp.folio}`);

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
    console.error(`[7-Eleven] ❌ ${err.message}`);

    if (err.response?.status === 502 || err.response?.status === 503) {
      return { success: false, error: 'Portal de 7-Eleven temporalmente no disponible.' };
    }

    return { success: false, error: err.message };
  }
}

// ============================================================
// PARSEO DE TICKET (Vision OCR → noTicket)
// ============================================================

/**
 * Extrae noTicket del texto OCR.
 * Es la secuencia de 35 dígitos bajo el código de barras.
 * Ejemplo: 14601404202621000072843500332981657
 */
function parsearTicket7Eleven(ocrText) {
  // Buscar secuencia de 30-40 dígitos
  const match = ocrText.match(/(\d{30,40})/);
  return match ? match[1] : null;
}

module.exports = { facturar7Eleven, parsearTicket7Eleven };
