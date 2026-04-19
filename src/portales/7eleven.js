/**
 * src/portales/7eleven.js — Adaptador HTTP para 7-Eleven México (PRODUCCIÓN)
 *
 * Cambios vs v1:
 *  - Credenciales y endpoints en env vars (con defaults seguros)
 *  - Idempotencia: cache de tickets ya facturados (in-memory + hook DB opcional)
 *  - Retry con backoff exponencial en HTTP (red flaky / 5xx)
 *  - Circuit breaker para Claude Vision (evita gastar tokens si Anthropic cae)
 *  - Validación estricta de inputs fiscales (RFC, CP, régimen, UUID, monto)
 *  - Logger estructurado inyectable (pino/winston compatible)
 *  - Errores sanitizados al usuario, detalles solo en logs
 *  - Métricas (duración, intentos captcha, status)
 *  - Email NO va en query string visible en logs (POST cuando es posible / redacted)
 *  - Códigos de error tipados (para retry decisions en la queue)
 *  - Timeouts configurables por etapa
 *  - AbortController para cancelación
 */

'use strict';

const axios = require('axios');

// ============================================================
// CONFIG (env vars con defaults)
// ============================================================
const CFG = Object.freeze({
  BASE: process.env.SEVENELEVEN_BASE_URL || 'https://www.e7-eleven.com.mx',
  AUTH: process.env.SEVENELEVEN_BASIC_AUTH || 'Basic a2V4dHdlYmFwaTprbGkkS0wtM1c=',
  USER_AGENT:
    process.env.SEVENELEVEN_UA ||
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  TIMEOUT_MS: Number(process.env.SEVENELEVEN_TIMEOUT_MS) || 20000,
  HTTP_RETRIES: Number(process.env.SEVENELEVEN_HTTP_RETRIES) || 2,
  CAPTCHA_RETRIES: Number(process.env.SEVENELEVEN_CAPTCHA_RETRIES) || 3,
  ANTHROPIC_KEY: process.env.ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL: process.env.ANTHROPIC_VISION_MODEL || 'claude-haiku-4-5-20251001',
  ANTHROPIC_TIMEOUT_MS: Number(process.env.ANTHROPIC_TIMEOUT_MS) || 12000,
  IDEMPOTENCY_TTL_MS: Number(process.env.SEVENELEVEN_IDEMP_TTL_MS) || 24 * 60 * 60 * 1000,
});

const API = `${CFG.BASE}/KJServices/webapi`;
const RFC_EMISOR = 'SEM980701STA';

function esCuerpoHtmlPortal(data) {
  if (typeof data !== 'string') return false;
  const t = data.trim().slice(0, 64).toLowerCase();
  return t.startsWith('<!') || t.startsWith('<html') || t.includes('403 forbidden') || t.includes('401 unauthorized');
}

/** Proxy HTTP(S) opcional (datacenters suelen recibir 403 del WAF de 7-Eleven). */
function proxyAxiosDesdeEnv() {
  const raw = process.env.SEVENELEVEN_HTTP_PROXY || process.env.SEVENELEVEN_PROXY || '';
  if (!raw.trim()) return undefined;
  try {
    const u = new URL(raw.trim());
    const port = u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80);
    const auth = u.username
      ? {
        username: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password || ''),
      }
      : undefined;
    return { protocol: u.protocol.replace(':', ''), host: u.hostname, port, auth };
  } catch {
    return undefined;
  }
}

// ============================================================
// ERRORES TIPADOS (la queue decide retry vs dead-letter)
// ============================================================
class FacturaError extends Error {
  constructor(code, userMessage, { retryable = false, cause, meta } = {}) {
    super(userMessage);
    this.name = 'FacturaError';
    this.code = code;            // INVALID_INPUT | TICKET_INVALID | TICKET_USED | TICKET_EXPIRED |
                                 // CAPTCHA_FAILED | PORTAL_DOWN | UPSTREAM_TIMEOUT | CFDI_REJECTED | UNKNOWN
    this.retryable = retryable;
    this.cause = cause;
    this.meta = meta;
  }
}

// ============================================================
// LOGGER (inyectable; default = console con shape estructurado)
// ============================================================
function defaultLogger() {
  const fmt = (level, msg, ctx) =>
    JSON.stringify({ ts: new Date().toISOString(), level, portal: '7eleven', msg, ...ctx });
  return {
    info: (m, c) => console.log(fmt('info', m, c)),
    warn: (m, c) => console.warn(fmt('warn', m, c)),
    error: (m, c) => console.error(fmt('error', m, c)),
    debug: (m, c) => process.env.DEBUG && console.log(fmt('debug', m, c)),
  };
}

// ============================================================
// VALIDACIÓN DE INPUTS
// ============================================================
const RFC_REGEX = /^[A-ZÑ&]{3,4}\d{6}[A-Z\d]{3}$/i;
const CP_REGEX = /^\d{5}$/;
const TICKET_REGEX = /^\d{30,40}$/;
const REGIMENES_VALIDOS = new Set([
  '601', '603', '605', '606', '607', '608', '610', '611', '612', '614',
  '615', '616', '620', '621', '622', '623', '624', '625', '626',
]);
const USOS_CFDI_VALIDOS = new Set([
  'G01', 'G02', 'G03', 'I01', 'I02', 'I03', 'I04', 'I05', 'I06', 'I07',
  'I08', 'D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07', 'D08', 'D09',
  'D10', 'CP01', 'CN01', 'S01',
]);

function validarInputs(ticket, fiscal) {
  if (!ticket?.noTicket || !TICKET_REGEX.test(String(ticket.noTicket))) {
    throw new FacturaError('INVALID_INPUT', 'Número de ticket inválido (debe tener 30–40 dígitos).');
  }
  if (!fiscal?.rfc || !RFC_REGEX.test(fiscal.rfc)) {
    throw new FacturaError('INVALID_INPUT', 'RFC inválido.');
  }
  if (!fiscal.nombre || fiscal.nombre.trim().length < 2) {
    throw new FacturaError('INVALID_INPUT', 'Razón social requerida.');
  }
  if (!fiscal.cp || !CP_REGEX.test(fiscal.cp)) {
    throw new FacturaError('INVALID_INPUT', 'Código postal inválido (5 dígitos).');
  }
  if (!fiscal.regimen || !REGIMENES_VALIDOS.has(String(fiscal.regimen))) {
    throw new FacturaError('INVALID_INPUT', 'Régimen fiscal inválido.');
  }
  if (!fiscal.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fiscal.email)) {
    throw new FacturaError('INVALID_INPUT', 'Email inválido.');
  }
  const uso = fiscal.usoCFDI || 'G03';
  if (!USOS_CFDI_VALIDOS.has(uso)) {
    throw new FacturaError('INVALID_INPUT', `Uso de CFDI inválido: ${uso}`);
  }
}

// ============================================================
// IDEMPOTENCIA — store inyectable (default in-memory con TTL)
// En prod: pasar { has, set } con Redis/PG.
// ============================================================
function memoryIdempotencyStore() {
  const map = new Map(); // key -> { value, exp }
  const gc = () => {
    const now = Date.now();
    for (const [k, v] of map) if (v.exp < now) map.delete(k);
  };
  return {
    async get(key) { gc(); return map.get(key)?.value || null; },
    async set(key, value, ttlMs = CFG.IDEMPOTENCY_TTL_MS) {
      map.set(key, { value, exp: Date.now() + ttlMs });
    },
  };
}
const _defaultIdemp = memoryIdempotencyStore();

// ============================================================
// CIRCUIT BREAKER simple para Anthropic
// ============================================================
const visionBreaker = {
  fails: 0,
  openedAt: 0,
  threshold: 5,
  cooldownMs: 60_000,
  canCall() {
    if (this.fails < this.threshold) return true;
    if (Date.now() - this.openedAt > this.cooldownMs) {
      this.fails = 0; this.openedAt = 0; return true;
    }
    return false;
  },
  ok() { this.fails = 0; this.openedAt = 0; },
  fail() { this.fails++; if (this.fails >= this.threshold) this.openedAt = Date.now(); },
};

// ============================================================
// SLEEP / RETRY HTTP con backoff
// ============================================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, { retries = CFG.HTTP_RETRIES, baseMs = 400, log, op } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      const transient =
        !err.response ||
        status >= 500 ||
        ['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'EAI_AGAIN'].includes(err.code);
      if (!transient || i === retries) break;
      const delay = baseMs * 2 ** i + Math.random() * 200;
      log?.warn('http_retry', { op, attempt: i + 1, status, code: err.code, delay });
      await sleep(delay);
    }
  }
  throw lastErr;
}

// ============================================================
// SESIÓN HTTP (auth + cookies)
// ============================================================
function crearSesion(signal) {
  const cookies = {};
  const proxy = proxyAxiosDesdeEnv();
  const session = axios.create({
    baseURL: CFG.BASE,
    timeout: CFG.TIMEOUT_MS,
    signal,
    ...(proxy ? { proxy } : {}),
    headers: {
      Accept: 'application/json, text/plain, */*',
      Authorization: CFG.AUTH,
      Referer: `${CFG.BASE}/facturacion/KPortalExterno/`,
      Origin: CFG.BASE,
      'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'User-Agent': CFG.USER_AGENT,
    },
    // No throw en 4xx para inspeccionar payloads de error del portal
    validateStatus: (s) => s >= 200 && s < 500,
  });

  session.interceptors.response.use((resp) => {
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

  session.interceptors.request.use((config) => {
    const str = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    if (str) config.headers['Cookie'] = str;
    return config;
  });

  return session;
}

// ============================================================
// CAPTCHA — Claude Vision con breaker
// ============================================================
async function resolverCaptchaVision(imgBuffer, log) {
  if (!CFG.ANTHROPIC_KEY) {
    throw new FacturaError('CAPTCHA_FAILED', 'Servicio de captcha no configurado.', { retryable: false });
  }
  if (!visionBreaker.canCall()) {
    throw new FacturaError('CAPTCHA_FAILED', 'Servicio de captcha temporalmente no disponible.', { retryable: true });
  }
  try {
    const resp = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: CFG.ANTHROPIC_MODEL,
        max_tokens: 50,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imgBuffer.toString('base64') } },
            { type: 'text', text: 'Lee el texto del captcha. Responde SOLO con los caracteres exactos, sin explicación, sin comillas, sin espacios. Letras minúsculas y/o números.' },
          ],
        }],
      },
      {
        headers: {
          'x-api-key': CFG.ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        timeout: CFG.ANTHROPIC_TIMEOUT_MS,
      }
    );
    visionBreaker.ok();
    const text = resp.data?.content?.[0]?.text?.trim().toLowerCase() || '';
    // sanitizar a [a-z0-9]
    return text.replace(/[^a-z0-9]/g, '');
  } catch (err) {
    visionBreaker.fail();
    log?.error('vision_error', { msg: err.message, status: err.response?.status });
    throw new FacturaError('CAPTCHA_FAILED', 'No se pudo resolver el captcha.', { retryable: true, cause: err });
  }
}

async function resolverCaptchaConRetry(session, log, max = CFG.CAPTCHA_RETRIES) {
  for (let i = 0; i < max; i++) {
    try {
      const { data: imgBuffer, status } = await session.get('/KPortalExterno/Kaptcha.jpg', {
        responseType: 'arraybuffer',
      });
      if (status >= 400 || !imgBuffer || imgBuffer.length < 500) {
        log.warn('captcha_empty', { attempt: i + 1, status, size: imgBuffer?.length || 0 });
        await sleep(300);
        continue;
      }
      const texto = await resolverCaptchaVision(Buffer.from(imgBuffer), log);
      if (!texto) { log.warn('captcha_empty_vision', { attempt: i + 1 }); continue; }

      const { data: val } = await session.get('/KPortalExterno/kaptcha', { params: { kaptcha: texto } });
      if (val?.esValido) {
        log.info('captcha_ok', { attempt: i + 1 });
        return texto;
      }
      log.warn('captcha_rejected', { attempt: i + 1, motivo: val?.mensaje });
    } catch (err) {
      if (err instanceof FacturaError) throw err;
      log.warn('captcha_attempt_error', { attempt: i + 1, msg: err.message });
    }
  }
  throw new FacturaError('CAPTCHA_FAILED', 'No se pudo validar el captcha tras varios intentos.', { retryable: true });
}

// ============================================================
// FLUJO PRINCIPAL
// ============================================================
/**
 * @param {Object} ticket  { noTicket }
 * @param {Object} fiscal  { rfc, nombre, cp, regimen, email, usoCFDI? }
 * @param {Object} [opts]  { logger, idempotencyStore, signal, requestId }
 */
async function facturar7Eleven(ticket, fiscal, opts = {}) {
  const log = opts.logger || defaultLogger();
  const idemp = opts.idempotencyStore || _defaultIdemp;
  const requestId = opts.requestId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const t0 = Date.now();

  try {
    validarInputs(ticket, fiscal);
  } catch (err) {
    log.warn('invalid_input', { requestId, code: err.code, msg: err.message });
    return errorResponse(err);
  }

  const { noTicket } = ticket;
  const { rfc, nombre, cp, regimen, email, usoCFDI = 'G03' } = fiscal;

  // ── Idempotencia ──
  const idempKey = `7eleven:${rfc}:${noTicket}`;
  const cached = await idemp.get(idempKey);
  if (cached) {
    log.info('idempotent_hit', { requestId, idempKey });
    return cached;
  }

  log.info('start', { requestId, ticket: maskTicket(noTicket), rfc: maskRfc(rfc) });
  const session = crearSesion(opts.signal);

  const msgPortal403 =
    '7-Eleven respondió 403 (bloqueo). Desde servidores en la nube (p. ej. Railway) el portal suele rechazar la IP. ' +
    'Opciones: configurar `SEVENELEVEN_HTTP_PROXY` con un proxy residencial en México, o ejecutar Cotas en tu PC/red local.';

  try {
    // 1. Init session
    const initResp = await withRetry(
      () => session.get('/facturacion/KPortalExterno/', { headers: { Accept: 'text/html' } }),
      { log, op: 'init_session' }
    );
    if ([401, 403, 429].includes(initResp.status)) {
      throw new FacturaError('PORTAL_FORBIDDEN', msgPortal403, {
        retryable: false,
        meta: { httpStatus: initResp.status, op: 'init_session' },
      });
    }

    // 2. Validar ticket
    const verificaResp = await withRetry(
      () => session.get(`${API}/FacturacionService/verificaTicketWS2`, { params: { noTicket } }),
      { log, op: 'verifica_ticket' }
    );
    const tv = verificaResp.data;

    if ([401, 403, 429].includes(verificaResp.status)) {
      throw new FacturaError('PORTAL_FORBIDDEN', msgPortal403, {
        retryable: false,
        meta: { httpStatus: verificaResp.status, op: 'verifica_ticket' },
      });
    }
    if (typeof tv === 'string' && esCuerpoHtmlPortal(tv)) {
      throw new FacturaError('PORTAL_FORBIDDEN', msgPortal403, {
        retryable: false,
        meta: {
          httpStatus: verificaResp.status,
          op: 'verifica_ticket',
          portalSnippet: tv.slice(0, 280),
        },
      });
    }
    if (tv == null || typeof tv !== 'object' || Array.isArray(tv)) {
      throw new FacturaError(
        'PORTAL_DOWN',
        'Respuesta inesperada del portal de 7-Eleven al validar el ticket.',
        { retryable: true, meta: { httpStatus: verificaResp.status, sample: String(tv).slice(0, 120) } }
      );
    }

    const statusNorm = tv.status !== undefined && tv.status !== null
      ? String(tv.status).trim()
      : '';

    if (statusNorm !== '0') {
      const map = {
        '1': ['TICKET_USED', 'Este ticket ya fue facturado anteriormente.'],
        '2': ['TICKET_INVALID', 'Ticket no encontrado. Verifica el número.'],
        '3': ['TICKET_EXPIRED', 'Ticket vencido. Solo se puede facturar dentro del mes + 5 días.'],
      };
      const [code, msg] = map[statusNorm] || ['TICKET_INVALID', tv?.mensajeValidacion || 'Ticket no facturable.'];
      const portalSnippet = typeof tv === 'object' && tv !== null
        ? JSON.stringify(tv).slice(0, 280)
        : String(tv ?? '').slice(0, 280);
      log.warn('verifica_ticket_rechazado', {
        requestId,
        portalStatus: statusNorm || '(missing)',
        mensajeValidacion: String(tv?.mensajeValidacion || '').slice(0, 120),
        ticket: maskTicket(noTicket),
      });
      throw new FacturaError(code, msg, {
        meta: {
          portalStatus: statusNorm || '(missing)',
          portalSnippet,
        },
      });
    }

    const total = Number.parseFloat(tv.totalTicket);
    if (!Number.isFinite(total) || total <= 0) {
      throw new FacturaError('TICKET_INVALID', 'El ticket no tiene un monto válido.', { meta: { totalRaw: tv.totalTicket } });
    }

    log.info('ticket_ok', { requestId, estacion: tv.estacion, total, formaPago: tv.formaPago });

    // 3. Captcha
    await resolverCaptchaConRetry(session, log);

    // 4. Generar CFDI
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

    const { data: facturaResp, status: facStatus } = await withRetry(
      () => session.post(`${API}/FacturaExpressService`, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }),
      { log, op: 'factura_express' }
    );

    const r = Array.isArray(facturaResp) ? facturaResp[0] : facturaResp;
    if (!r?.cfdiDisponible) {
      throw new FacturaError('CFDI_REJECTED', sanitizePortalMsg(r?.respuesta) || 'CFDI no generado por el portal.',
        { meta: { facStatus } });
    }

    const uuid = r.uuid;
    if (!uuid) throw new FacturaError('CFDI_REJECTED', 'CFDI sin UUID.', {});

    log.info('cfdi_generated', { requestId, uuid });

    // 5 + 6. PDF + XML en paralelo (independientes)
    const [pdfRes, xmlRes] = await Promise.all([
      withRetry(
        () => session.get(`${API}/FacturaExpressService/descargaCfdiPdf`, { params: { uuid } }),
        { log, op: 'download_pdf' }
      ),
      withRetry(
        () => session.get(`${API}/FacturaExpressService/descargaCfdiXml`, { params: { email, uuid } }),
        { log, op: 'download_xml' }
      ),
    ]);

    const pdfResp = pdfRes.data;
    const xmlResp = xmlRes.data;

    const result = {
      success: true,
      portal: '7eleven',
      uuid,
      total,
      folio: xmlResp?.folio,
      serie: xmlResp?.serie,
      rfcEmisor: RFC_EMISOR,
      b64Pdf: pdfResp?.b64Pdf,
      xml: xmlResp?.xml || xmlResp?.interpretado,
      meta: { estacion: tv.estacion, formaPago: tv.formaPago, durationMs: Date.now() - t0 },
    };

    if (!result.b64Pdf || !result.xml) {
      throw new FacturaError('CFDI_REJECTED', 'CFDI generado pero sin PDF/XML descargable.',
        { meta: { hasPdf: !!result.b64Pdf, hasXml: !!result.xml } });
    }

    await idemp.set(idempKey, result);
    log.info('done', { requestId, uuid, durationMs: result.meta.durationMs });
    return result;

  } catch (err) {
    return handleError(err, log, requestId, t0);
  }
}

// ============================================================
// HELPERS
// ============================================================
function maskTicket(t) { return t ? `${t.slice(0, 6)}…${t.slice(-4)}` : ''; }
function maskRfc(r) { return r ? `${r.slice(0, 4)}***${r.slice(-3)}` : ''; }

function sanitizePortalMsg(m) {
  if (!m || typeof m !== 'string') return null;
  // recorta y quita HTML básico
  return m.replace(/<[^>]+>/g, '').trim().slice(0, 200);
}

function errorResponse(err) {
  const out = {
    success: false,
    portal: '7eleven',
    code: err.code || 'UNKNOWN',
    error: err.message || 'Error desconocido.',
    retryable: !!err.retryable,
  };
  const isFactura = err instanceof FacturaError || err?.name === 'FacturaError';
  if (isFactura && err.meta) {
    if (err.meta.portalStatus !== undefined && err.meta.portalStatus !== null) {
      out.portalStatus = String(err.meta.portalStatus);
    } else if (err.meta.httpStatus !== undefined && err.meta.httpStatus !== null) {
      out.portalStatus = `http_${err.meta.httpStatus}`;
    }
    if (err.meta.portalSnippet) {
      out.portalSnippet = err.meta.portalSnippet;
    }
  }
  return out;
}

function handleError(err, log, requestId, t0) {
  const durationMs = Date.now() - t0;

  if (err instanceof FacturaError) {
    log[err.retryable ? 'warn' : 'error']('factura_error', {
      requestId, code: err.code, retryable: err.retryable, msg: err.message, durationMs, meta: err.meta,
    });
    return errorResponse(err);
  }

  const status = err.response?.status;
  const code = err.code;
  const transient =
    !err.response || status >= 500 || ['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED'].includes(code);

  log.error('unexpected_error', { requestId, status, code, msg: err.message, durationMs });

  if (status === 502 || status === 503 || status === 504) {
    return errorResponse(new FacturaError('PORTAL_DOWN', 'Portal de 7-Eleven no disponible. Intenta más tarde.', { retryable: true }));
  }
  if (transient) {
    return errorResponse(new FacturaError('UPSTREAM_TIMEOUT', 'Conexión con el portal interrumpida. Reintenta.', { retryable: true }));
  }
  return errorResponse(new FacturaError('UNKNOWN', 'No se pudo procesar la factura. Intenta de nuevo.', { retryable: false }));
}

// ============================================================
// PARSEO DE TICKET (OCR → noTicket)
// ============================================================
function parsearTicket7Eleven(ocrText) {
  if (!ocrText || typeof ocrText !== 'string') return null;
  // limpia espacios y saltos antes de matchear (algunos OCR rompen el número)
  const cleaned = ocrText.replace(/[\s\-]/g, '');
  const match = cleaned.match(/(\d{30,40})/);
  return match ? match[1] : null;
}

module.exports = {
  facturar7Eleven,
  parsearTicket7Eleven,
  // exports adicionales útiles para tests / integración
  FacturaError,
  validarInputs,
  memoryIdempotencyStore,
  _config: CFG,
};
