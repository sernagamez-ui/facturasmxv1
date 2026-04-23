/**
 * McDonald's México — facturacionmcdonalds.com.mx
 * Flujo (HAR): GET / → ci_session → POST /index.php/request (status_ticket=3 validar)
 * → POST /index.php/final_client (RFC) → POST /index.php/request (status_ticket=1, status_form=0)
 * → POST /index.php/request (status_form=1 confirmar) → data.xml en base64
 */

'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { getProxyAgent } = require('../proxyAgent');

const BASE = 'https://www.facturacionmcdonalds.com.mx';

function mcdHttp(extra = {}) {
  const agent = getProxyAgent('rotating');
  if (!agent) return extra;
  return {
    ...extra,
    httpsAgent: agent,
    httpAgent: agent,
    proxy: false,
  };
}

const BROWSER_HEADERS = {
  Accept: 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'es-MX,es;q=0.9',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  Origin: BASE,
  Referer: `${BASE}/`,
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  'X-Requested-With': 'XMLHttpRequest',
};

class CookieJar {
  constructor() {
    /** @type {Record<string, string>} */
    this.map = {};
  }

  /** @param {string|string[]|undefined} setCookie */
  ingestSetCookie(setCookie) {
    if (!setCookie) return;
    const lines = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const line of lines) {
      const part = String(line).split(';')[0];
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      const k = part.slice(0, eq).trim();
      const v = part.slice(eq + 1).trim();
      if (k) this.map[k] = v;
    }
  }

  header() {
    return Object.entries(this.map)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
}

/** @param {string} ymd */
function fechaYmdToTicketDmy(ymd) {
  const [y, m, d] = String(ymd).split('-').map((x) => x.trim());
  if (!y || !m || !d) throw new Error('fecha inválida (use YYYY-MM-DD)');
  const dd = d.padStart(2, '0');
  const mm = m.padStart(2, '0');
  return `${dd}/${mm}/${y}`;
}

function normStore(code) {
  const s = String(code || '').replace(/\D/g, '');
  if (!s) throw new Error('number_store vacío');
  return s.length <= 4 ? s.padStart(4, '0') : s;
}

function normCaja(c) {
  const s = String(c ?? '').replace(/\D/g, '');
  if (!s) throw new Error('num_caja vacío');
  return s;
}

function normTicket(t) {
  const s = String(t ?? '').replace(/\s/g, '');
  if (!s) throw new Error('num_ticket vacío');
  return s;
}

function nombreForm(nombre) {
  return String(nombre || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '+');
}

function extraerUuidXml(xml) {
  const m = String(xml || '').match(/UUID="([0-9A-Fa-f-]{36})"/i);
  return m ? m[1].toUpperCase() : null;
}

function logMcd(etapa, obj) {
  try {
    const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
    console.log(`[McDonalds] ${etapa}:`, s.length > 1400 ? `${s.slice(0, 1400)}…` : s);
  } catch {
    console.log(`[McDonalds] ${etapa}:`, String(obj).slice(0, 400));
  }
}

function snippetPortal(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const parts = [obj.msj, obj.error, obj.mensaje, obj.message].filter(Boolean);
  const t = parts.map(String).join(' — ');
  if (t) return t.slice(0, 500);
  try {
    return JSON.stringify(obj).slice(0, 500);
  } catch {
    return '';
  }
}

function tieneFacturaXml(d) {
  return !!(d && d.object === 'invoice' && d.data && d.data.xml);
}

/**
 * @param {object} p
 * @param {string} p.number_store — código de tienda (ej. "0807", "0156")
 * @param {string} p.num_ticket — folio ticket (ej. "000027206" o "103752")
 * @param {string} p.num_caja — caja / Reg. (ej. "01", "76")
 * @param {string} p.fecha — YYYY-MM-DD
 * @param {number} p.total
 * @param {object} p.userData — rfc, nombre, cp, regimen, email
 * @param {string} p.outputDir
 */
async function facturarMcDonalds({
  number_store,
  num_ticket,
  num_caja,
  fecha,
  total,
  userData,
  outputDir,
}) {
  const jar = new CookieJar();
  const rfc = String(userData.rfc || '')
    .trim()
    .toUpperCase();
  const regimeId = String(userData.regimen || '').replace(/\D/g, '');
  const cp = String(userData.cp || '')
    .replace(/\D/g, '')
    .slice(0, 5);

  if (!rfc || !regimeId || !cp) {
    return { ok: false, error: 'datos_fiscales', mensaje: 'RFC, régimen y CP son obligatorios para McDonald\'s.' };
  }

  const store = normStore(number_store);
  const ticket = normTicket(num_ticket);
  const caja = normCaja(num_caja);
  const fechaTicket = fechaYmdToTicketDmy(fecha);
  const totalStr = Number(total).toFixed(2);

  const client = axios.create({
    ...mcdHttp({ timeout: 90000, maxRedirects: 5, validateStatus: (s) => s < 500 }),
    transformResponse: [(data) => data],
  });

  client.interceptors.response.use((res) => {
    jar.ingestSetCookie(res.headers['set-cookie']);
    return res;
  });

  function headersForm() {
    return {
      ...BROWSER_HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Cookie: jar.header(),
    };
  }

  try {
    const home = await client.get(`${BASE}/`, mcdHttp({ headers: { ...BROWSER_HEADERS, Cookie: jar.header() } }));
    jar.ingestSetCookie(home.headers['set-cookie']);

    if (getProxyAgent('rotating')) {
      console.log('[McDonalds] peticiones vía PROXY_URL_ROTATING');
    }

    // 1) Validar ticket (status_ticket=3) — HAR
    const bodyValidar = new URLSearchParams({
      number_store: store,
      num_ticket: ticket,
      num_caja: caja,
      fecha_ticket: fechaTicket,
      total_ticket: totalStr,
      status_ticket: '3',
    });

    const resVal = await client.post(`${BASE}/index.php/request`, bodyValidar.toString(), {
      ...mcdHttp(),
      headers: headersForm(),
    });
    const val = JSON.parse(resVal.data);
    logMcd('validar ticket (status_ticket=3)', val);
    if (val.status === 5 || /facturado|previously/i.test(String(val.previously || ''))) {
      return { ok: false, error: 'ya_facturado', mensaje: val.msj || 'Ticket ya facturado.' };
    }
    if (val.status !== 2 && val.success !== 'number_ticket') {
      return {
        ok: false,
        error: 'ticket_invalido',
        mensaje: val.msj || val.error || JSON.stringify(val),
      };
    }

    // 2) Consulta RFC en portal (HAR: final_client)
    await client.post(
      `${BASE}/index.php/final_client`,
      new URLSearchParams({ search: rfc }).toString(),
      mcdHttp({ headers: headersForm() })
    );

    // 3) Primer envío datos fiscales (status_form=0)
    const buildIssueBody = (statusForm) => {
      const p = new URLSearchParams();
      p.set('number_store', store);
      p.set('num_ticket', ticket);
      p.set('num_caja', caja);
      p.set('fecha_ticket', fechaTicket);
      p.set('total_ticket', totalStr);
      p.set('tax_id_receiver', rfc);
      p.set('name_receiver', nombreForm(userData.nombre));
      p.set('email_receiver', String(userData.email || '').trim());
      p.set('status_form', String(statusForm));
      p.set('fc', '0');
      p.set('comp_status', '0');
      p.set('data_comple[tipo_proceso]', '0');
      p.set('data_comple[tipo_comite]', '0');
      p.set('data_comple[clave_conta]', '');
      p.set('data_comple[entidad]', '0');
      p.set('data_comple[ambito]', '0');
      p.set('status_ticket', '1');
      p.set('status_up', '0');
      p.set('payment_method', '0');
      p.set('cp_client', cp);
      p.set('regime_id', regimeId);
      return p.toString();
    };

    const res1 = await client.post(`${BASE}/index.php/request`, buildIssueBody(0), {
      ...mcdHttp(),
      headers: headersForm(),
    });
    const d1 = JSON.parse(res1.data);
    logMcd('emisión paso A (status_form=0)', d1);

    if (tieneFacturaXml(d1)) {
      return finalizeInvoice(d1, outputDir);
    }

    // Confirmación intermedia (HAR: status 1 — "¿Estás seguro?" → mismo POST con status_form=1)
    if (d1.status === 1) {
      const postConfirm = async () =>
        client.post(`${BASE}/index.php/request`, buildIssueBody(1), {
          ...mcdHttp(),
          headers: headersForm(),
        });

      let res2 = await postConfirm();
      let d2 = JSON.parse(res2.data);
      logMcd('emisión paso B (status_form=1)', d2);

      if (tieneFacturaXml(d2)) {
        return finalizeInvoice(d2, outputDir);
      }

      if (d2.status === 1) {
        res2 = await postConfirm();
        d2 = JSON.parse(res2.data);
        logMcd('emisión paso B2 (status_form=1 reintento)', d2);
        if (tieneFacturaXml(d2)) {
          return finalizeInvoice(d2, outputDir);
        }
      }

      return {
        ok: false,
        error: 'emision_error',
        mensaje: d2.msj || d2.error || JSON.stringify(d2).slice(0, 600),
        portalSnippet: snippetPortal(d2),
        portalStatus: res2.status,
      };
    }

    return {
      ok: false,
      error: 'portal_error',
      mensaje: d1.msj || d1.error || JSON.stringify(d1).slice(0, 400),
      portalSnippet: snippetPortal(d1),
    };
  } catch (err) {
    const status = err.response?.status;
    if (status === 407) {
      return { ok: false, error: 'proxy_auth', mensaje: 'Proxy HTTP 407 — revisa PROXY_URL_ROTATING.' };
    }
    if (status === 403 || status === 401) {
      return {
        ok: false,
        error: 'portal_forbidden',
        mensaje: 'El portal rechazó la conexión (403/401). Prueba proxy en México o red local.',
      };
    }
    const msg = err.response?.data ? String(err.response.data).slice(0, 500) : err.message;
    return { ok: false, error: 'mcd_error', mensaje: msg };
  }
}

function finalizeInvoice(data, outputDir) {
  const b64 = data.data.xml;
  let xmlStr;
  try {
    xmlStr = Buffer.from(b64, 'base64').toString('utf-8');
  } catch {
    return { ok: false, error: 'xml_invalido', mensaje: 'Respuesta sin XML válido.' };
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const uuid = extraerUuidXml(xmlStr) || `mcd_${Date.now()}`;
  const safeUuid = String(uuid).replace(/[^\w-]/g, '_');
  const xmlPath = path.join(outputDir, `mcdonalds_${safeUuid}.xml`);
  fs.writeFileSync(xmlPath, xmlStr, 'utf-8');

  return {
    ok: true,
    xmlPath,
    uuid: extraerUuidXml(xmlStr),
    pdfPath: null,
    envioPorCorreo: false,
  };
}

module.exports = { facturarMcDonalds, fechaYmdToTicketDmy };
