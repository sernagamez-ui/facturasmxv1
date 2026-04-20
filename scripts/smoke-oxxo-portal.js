#!/usr/bin/env node
/**
 * Prueba rápida: ¿carga el portal OXXO tienda y existe el campo folio?
 * Uso: node scripts/smoke-oxxo-portal.js
 *
 * No factura; solo navega.
 * Por defecto Playwright va sin proxy (OXXO usa puerto 9443; muchos proxies residenciales fallan el túnel).
 * Para probar con proxy: OXXO_TIENDA_USE_PLAYWRIGHT_PROXY=1 node scripts/smoke-oxxo-portal.js
 */

require('dotenv').config();
const { chromium } = require('playwright');
const { getPlaywrightProxyOxxoTienda } = require('../src/proxyAgent');

const PORTAL_URL =
  'https://www4.oxxo.com:9443/facturacionElectronica-web/views/layout/inicio.do';

async function main() {
  const proxy = getPlaywrightProxyOxxoTienda();
  if (proxy) console.log('Playwright: proxy activo (OXXO_TIENDA_USE_PLAYWRIGHT_PROXY=1)');
  else console.log('Playwright: sin proxy para OXXO tienda (defecto; evita ERR_TUNNEL en :9443)');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    ...(proxy ? { proxy } : {}),
  });
  const page = await browser.newPage({
    ignoreHTTPSErrors: true,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });

  try {
    console.log('GET', PORTAL_URL);
    const res = await page.goto(PORTAL_URL, {
      waitUntil: 'networkidle',
      timeout: 120_000,
    });
    console.log('HTTP', res?.status(), 'final URL:', page.url());
    console.log('title:', await page.title());

    const sel = '[id="form:folio"], input[name="form:folio"]';
    await page.waitForSelector(sel, { state: 'visible', timeout: 60_000 });
    console.log('OK: formulario de folio visible.');
  } catch (e) {
    console.error('FALLO:', e.message);
    if (String(e.message).includes('ERR_TUNNEL')) {
      console.error(
        '\nNota: ERR_TUNNEL_CONNECTION_FAILED con proxy en puerto 9443 es habitual con proxies residenciales.\n' +
          'Quita OXXO_TIENDA_USE_PLAYWRIGHT_PROXY o ejecútalo sin esa variable (conexión directa desde IP México).'
      );
    }
    const snippet = await page.content().catch(() => '');
    console.error('HTML (primeros 800 chars):', snippet.slice(0, 800));
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
