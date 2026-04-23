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

/**
 * Razón social para el formulario. Solo MAYÚSCULAS y espacios colapsados.
 * No sustituir espacios por "+" aquí: URLSearchParams ya codifica espacio como +
 * en application/x-www-form-urlencoded; si metemos "+" a mano, se envía %2B y el
 * servidor recibe signos "+" literales (el SAT no coincide con el nombre del RFC).
 */
function nombreForm(nombre) {
  return String(nombre || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
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

/** @param {string} [etapa] — para logs si el cuerpo no es JSON */
function parseMcdJsonBody(raw, etapa = 'respuesta') {
  if (raw == null || raw === '') {
    console.error(`[McDonalds] ${etapa}: cuerpo vacío`);
    throw new Error(`McDonald's: respuesta vacía (${etapa})`);
  }
  const s = typeof raw === 'string' ? raw : String(raw);
  const t = s.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) {
    console.error(`[McDonalds] ${etapa}: no parece JSON:`, t.slice(0, 500));
    throw new Error(`McDonald's: respuesta no JSON (${etapa})`);
  }
  try {
    return JSON.parse(s);
  } catch (e) {
    console.error(`[McDonalds] ${etapa}: JSON inválido:`, e.message, t.slice(0, 400));
    throw new Error(`McDonald's: JSON inválido (${etapa})`);
  }
}

function esErrorRedInterrumpida(err) {
  const code = String(err?.code || '');
  const msg = String(err?.message || '');
  const blob = `${code} ${msg}`;
  if (/ECONNRESET|ECONNABORTED|ETIMEDOUT|ECANCELED|EPIPE|ENOTFOUND|EAI_AGAIN/i.test(blob)) return true;
  if (/socket hang up|canceled|cancelled/i.test(msg)) return true;
  return axios.isCancel?.(err) === true;
}

/** Respuestas object:error del PAC con detalles SAT (CFDI40xxx). */
function extraerMensajesSatDesdeErrorPortal(obj) {
  const codes = [];
  const lines = [];
  const details = obj?.details;
  if (!Array.isArray(details)) return { text: '', codes };
  for (const det of details) {
    const errs = det?.errors;
    if (!Array.isArray(errs)) continue;
    for (const e of errs) {
      if (e?.code) codes.push(String(e.code).trim().toUpperCase());
      if (e?.description) lines.push(String(e.description).trim());
    }
  }
  const uniq = [...new Set(lines)];
  return { text: uniq.join('\n'), codes };
}

function esErrorNombreRazonReceptorSat(codes) {
  return codes.some((c) => c === 'CFDI40144' || c === 'CFDI40145');
}

function snippetPortal(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const { text } = extraerMensajesSatDesdeErrorPortal(obj);
  if (text) return text.slice(0, 900);
  const parts = [obj.msj, obj.error, obj.mensaje, obj.message].filter(Boolean);
  const t = parts.map(String).join(' — ');
  if (t) return t.slice(0, 500);
  try {
    return JSON.stringify(obj).slice(0, 500);
  } catch {
    return '';
  }
}

function clasificarErrorTimbrado(d2) {
  const sat = extraerMensajesSatDesdeErrorPortal(d2);
  if (sat.text && esErrorNombreRazonReceptorSat(sat.codes)) {
    return {
      error: 'receptor_sat',
      mensaje: sat.text,
      portalSnippet: sat.text.slice(0, 900),
    };
  }
  if (sat.text) {
    return {
      error: 'emision_error',
      mensaje: sat.text,
      portalSnippet: sat.text.slice(0, 900),
    };
  }
  return {
    error: 'emision_error',
    mensaje: d2.msj || d2.error || JSON.stringify(d2).slice(0, 600),
    portalSnippet: snippetPortal(d2),
  };
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
    const val = parseMcdJsonBody(resVal.data, 'validar ticket');
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
    const d1 = parseMcdJsonBody(res1.data, 'emisión paso A');
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

      let res2;
      let d2;
      try {
        res2 = await postConfirm();
        console.log(
          '[McDonalds] emisión paso B HTTP',
          res2.status,
          'body:',
          String(res2.data == null ? '' : res2.data).slice(0, 280)
        );
        d2 = parseMcdJsonBody(res2.data, 'emisión paso B');
        logMcd('emisión paso B (status_form=1)', d2);
      } catch (e) {
        const st = e.response?.status;
        const axBody = e.response?.data != null ? String(e.response.data).slice(0, 500) : '';
        const prevBody = res2?.data != null ? String(res2.data).slice(0, 500) : '';
        console.error(
          '[McDonalds] fallo paso B (confirmar timbrado):',
          e.message,
          'http:',
          st || 'n/a',
          axBody ? `resp:${axBody.slice(0, 200)}` : prevBody ? `body:${prevBody.slice(0, 200)}` : ''
        );
        if (st === 407) {
          return { ok: false, error: 'proxy_auth', mensaje: 'Proxy HTTP 407 — revisa PROXY_URL_ROTATING.' };
        }
        if (st === 403 || st === 401) {
          return {
            ok: false,
            error: 'portal_forbidden',
            mensaje: 'El portal rechazó la conexión (403/401). Prueba proxy en México o red local.',
          };
        }
        if (st === 504 || st === 502 || st === 503) {
          return {
            ok: false,
            error: 'mcd_timeout',
            mensaje: `Tiempo agotado al confirmar (HTTP ${st}). Reintenta en unos minutos.`,
          };
        }
        const em = String(e.message || '');
        if (/JSON inválido|no parece JSON|respuesta vacía|respuesta no JSON/i.test(em)) {
          return {
            ok: false,
            error: 'mcd_respuesta_portal',
            mensaje:
              'McDonald\'s respondió algo que no es JSON al confirmar (HTML, vacío o error intermedio). Suele ser proxy o portal inestable. Reintenta o prueba otra red.',
            portalSnippet: (prevBody || em).slice(0, 400),
            portalStatus: res2?.status,
          };
        }
        if (e.response) {
          return {
            ok: false,
            error: 'mcd_error',
            mensaje: em,
            portalSnippet: axBody || em,
            portalStatus: st,
          };
        }
        throw e;
      }

      if (tieneFacturaXml(d2)) {
        return finalizeInvoice(d2, outputDir);
      }

      if (d2.status === 1) {
        let resB2;
        try {
          resB2 = await postConfirm();
          console.log(
            '[McDonalds] emisión paso B2 HTTP',
            resB2.status,
            'body:',
            String(resB2.data == null ? '' : resB2.data).slice(0, 280)
          );
          d2 = parseMcdJsonBody(resB2.data, 'emisión paso B2');
          res2 = resB2;
          logMcd('emisión paso B2 (status_form=1 reintento)', d2);
        } catch (e) {
          console.error('[McDonalds] fallo paso B2:', e.message, e.response?.status);
          const prevBody = resB2?.data != null ? String(resB2.data).slice(0, 500) : '';
          return {
            ok: false,
            error: 'mcd_respuesta_portal',
            mensaje: String(e.message).slice(0, 400),
            portalSnippet: prevBody.slice(0, 400),
            portalStatus: resB2?.status ?? res2?.status,
          };
        }
        if (tieneFacturaXml(d2)) {
          return finalizeInvoice(d2, outputDir);
        }
      }

      const tim = clasificarErrorTimbrado(d2);
      return {
        ok: false,
        error: tim.error,
        mensaje: tim.mensaje,
        portalSnippet: tim.portalSnippet,
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
    console.error(
      '[McDonalds] excepción:',
      err.message,
      'http:',
      status || 'n/a',
      'code:',
      err.code || 'n/a',
      err.response?.data != null ? `body:${String(err.response.data).slice(0, 350)}` : ''
    );
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
    // 504/502/503: gateway del PAC, proxy MX o balanceador; el timbrado puede tardar >60s
    const msgAxios = String(err.message || '');
    if (status === 504 || status === 502 || status === 503) {
      return {
        ok: false,
        error: 'mcd_timeout',
        mensaje: `Tiempo de espera agotado en el portal o en la ruta de red (HTTP ${status}). McDonald's a veces tarda al timbrar. Reintenta en unos minutos.`,
      };
    }
    if (/status code 502|status code 503|status code 504/i.test(msgAxios)) {
      return {
        ok: false,
        error: 'mcd_timeout',
        mensaje:
          'Tiempo de espera (502/503/504) al contactar el portal o el proxy. Reintenta en unos minutos.',
      };
    }
    if (esErrorRedInterrumpida(err)) {
      return {
        ok: false,
        error: 'mcd_red',
        mensaje:
          'Se cortó la conexión con el portal (red, proxy o el contenedor se reinició durante el timbrado). ' +
          'Es común si el hosting hace *Stopping Container* en un deploy. Reintenta cuando el servicio esté estable.',
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
