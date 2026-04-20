#!/usr/bin/env node
/**
 * Prueba rápida: sesión en facturacionmcdonalds.com.mx + POST /index.php/request (validación).
 * Uso: node scripts/smoke-mcdonalds.js
 *
 * No emite factura: envía un ticket ficticio y comprueba que el portal responde JSON
 * (típico: ticket inválido / no encontrado — lo importante es red + API).
 *
 * Proxy (opcional): misma variable que el adaptador — PROXY_URL_ROTATING
 */

require('dotenv').config();
const axios = require('axios');
const { getProxyAgent } = require('../src/proxyAgent');

const BASE = 'https://www.facturacionmcdonalds.com.mx';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

let cachedAgentConfig = null;

function mcdHttp(extra = {}) {
  if (cachedAgentConfig === null) {
    try {
      const agent = getProxyAgent('rotating');
      cachedAgentConfig = agent
        ? { httpsAgent: agent, httpAgent: agent, proxy: false }
        : {};
      console.log(agent ? 'HTTP: usando PROXY_URL_ROTATING' : 'HTTP: sin proxy (conexión directa)');
    } catch (e) {
      console.warn('Proxy:', e.message, '— continuando sin proxy.');
      console.log('HTTP: sin proxy (conexión directa)');
      cachedAgentConfig = {};
    }
  }
  return { ...cachedAgentConfig, ...extra };
}

function ingestSetCookie(jar, setCookie) {
  if (!setCookie) return;
  const lines = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const line of lines) {
    const part = String(line).split(';')[0];
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) jar[k] = v;
  }
}

function cookieHeader(jar) {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

async function main() {
  const jar = /** @type {Record<string, string>} */ ({});

  console.log('GET', `${BASE}/`);
  const home = await axios.get(`${BASE}/`, mcdHttp({ timeout: 45000, headers: { 'User-Agent': UA } }));
  ingestSetCookie(jar, home.headers['set-cookie']);
  console.log('HTTP', home.status, jar.ci_session ? 'ci_session: ok' : 'ci_session: (no Set-Cookie — revisar)');

  const body = new URLSearchParams({
    number_store: '0001',
    num_ticket: '12345',
    num_caja: '99',
    fecha_ticket: '01/01/2020',
    total_ticket: '1.00',
    status_ticket: '3',
  });

  console.log('POST', `${BASE}/index.php/request`, '(ticket ficticio, status_ticket=3)');
  const res = await axios.post(`${BASE}/index.php/request`, body.toString(), mcdHttp({
    timeout: 60000,
    headers: {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Origin: BASE,
      Referer: `${BASE}/`,
      Cookie: cookieHeader(jar),
      'User-Agent': UA,
    },
    validateStatus: (s) => s < 500,
  }));

  ingestSetCookie(jar, res.headers['set-cookie']);
  const data = res.data;
  const preview = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data).slice(0, 1200);

  console.log('HTTP', res.status);
  console.log('Cuerpo:', preview.slice(0, 900) + (preview.length > 900 ? '…' : ''));

  if (typeof data !== 'object' || data === null) {
    console.error('FALLO: respuesta no es JSON.');
    process.exitCode = 1;
    return;
  }

  if (data.status === 2 && data.success === 'number_ticket') {
    console.warn(
      'AVISO: el ticket ficticio fue aceptado (inesperado). Comprueba datos o portal de prueba.'
    );
  } else {
    console.log('OK: portal respondió JSON en /request (conectividad + sesión).');
  }
}

main().catch((err) => {
  const status = err.response?.status;
  const body = err.response?.data;
  console.error('FALLO:', status || '', err.message);
  if (body !== undefined) console.error('Cuerpo:', typeof body === 'string' ? body.slice(0, 600) : body);
  if (status === 407) {
    console.error('Nota: proxy 407 — revisa credenciales en PROXY_URL_ROTATING.');
  }
  if (status === 403) {
    console.error('Nota: 403 desde datacenter — prueba proxy MX o red local.');
  }
  process.exitCode = 1;
});
