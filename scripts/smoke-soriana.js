#!/usr/bin/env node
/**
 * Smoke test Soriana — valida sesión y conectividad con el portal de facturación.
 * NO emite factura; solo navega y llama Billing-TipoTicket para ver si la sesión funciona.
 *
 * Uso:
 *   node scripts/smoke-soriana.js
 *
 * Variables opcionales (en .env o en el entorno):
 *   SORIANA_TEST_TICKET   — número de ticket real (≥10 dígitos) para probar Billing-TipoTicket
 *                           Si no se pone, solo se valida que la sesión no redirige a login.
 *   SORIANA_USE_PLAYWRIGHT_PROXY=1 + SORIANA_PROXY_URL / PROXY_URL_SOCKS5 / PROXY_URL_STICKY
 *                           — proxy residencial MX (necesario en Railway / IPs de datacenter)
 *
 * Si la sesión expiró, el script te lo indica y te dice cómo renovarla.
 */

require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { resolveDataDir } = require('../src/dataDir');
const { prepareSorianaPlaywrightProxy } = require('../src/proxyAgent');

const DATA_DIR    = resolveDataDir();
const SESSION_FILE = path.join(DATA_DIR, 'soriana-session.json');
const BASE        = 'https://www.soriana.com';
const FACTURA_URL = `${BASE}/facturacionelectronica#FacturarCompra`;
const DW          = '/on/demandware.store/Sites-Soriana-Site/default';
const OUT_DIR     = path.join(__dirname, '..', 'tmp', 'soriana-debug');

fs.mkdirSync(OUT_DIR, { recursive: true });

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────
function checkSessionFile() {
  if (!fs.existsSync(SESSION_FILE)) {
    console.error('❌  No hay sesión Soriana:', SESSION_FILE);
    console.error('   Genera una con:  node save-session.js soriana');
    process.exit(1);
  }

  let session;
  try {
    session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  } catch (e) {
    console.error('❌  soriana-session.json no es JSON válido:', e.message);
    process.exit(1);
  }

  const now = Date.now() / 1000;
  const atCookie = (session.cookies || []).find((c) => c.name === 'cc-at_Soriana');
  const usidCookie = (session.cookies || []).find((c) => c.name === 'usid_Soriana');

  if (atCookie && atCookie.expires > 0) {
    const expMs = atCookie.expires * 1000;
    const diffMin = Math.round((atCookie.expires - now) / 60);
    if (atCookie.expires < now) {
      console.warn(`⚠️  cc-at_Soriana EXPIRÓ hace ${Math.abs(diffMin)} min (${new Date(expMs).toISOString()})`);
      console.warn('   El token de acceso caducó; el bot obtendrá un error al llamar la API.');
      console.warn('   → Renueva la sesión con:  node save-session.js soriana');
    } else {
      console.log(`✅  cc-at_Soriana válido — expira en ${diffMin} min (${new Date(expMs).toISOString()})`);
    }
  } else {
    console.log('ℹ️  cc-at_Soriana no encontrado o sin fecha de expiración');
  }

  if (usidCookie && usidCookie.expires > 0) {
    const expMs = usidCookie.expires * 1000;
    const diffDays = Math.round((usidCookie.expires - now) / 86400);
    if (usidCookie.expires < now) {
      console.warn(`⚠️  usid_Soriana EXPIRÓ (${new Date(expMs).toISOString()})`);
    } else {
      console.log(`✅  usid_Soriana válido — expira en ${diffDays} días`);
    }
  }

  return session;
}

// ──────────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== Smoke test Soriana ===\n');

  checkSessionFile();

  const prepared = await prepareSorianaPlaywrightProxy();
  const { proxy, teardown } = prepared;
  console.log('\n[proxy]', proxy ? `activo → ${proxy.server}` : 'sin proxy (SORIANA_USE_PLAYWRIGHT_PROXY no está en 1)');

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
      ],
      ...(proxy ? { proxy } : {}),
    });

    const context = await browser.newContext({
      storageState: SESSION_FILE,
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      extraHTTPHeaders: { 'accept-language': 'es-MX,es;q=0.9' },
    });
    const page    = await context.newPage();

    // ── 1. Navegar ────────────────────────────────────────────────────────────
    console.log('\n[1] Navegando a facturacionelectronica…');
    await page.goto(FACTURA_URL, { waitUntil: 'load', timeout: 120_000 });

    let title = await page.title();
    // Esperar resolución de Cloudflare challenge
    if (/Attention Required|Just a moment/i.test(title)) {
      console.log('    ⚠️  Cloudflare challenge, esperando 20 s...');
      try {
        await page.waitForFunction(
          () => !document.title.includes('Attention Required') && !document.title.includes('Just a moment'),
          { timeout: 20_000 }
        );
        title = await page.title();
      } catch (_) {
        console.warn('    ⚠️  Challenge no resolvió en 20 s (posible bloqueo por fingerprint headless)');
      }
    }

    const finalUrl = page.url();
    console.log('    URL final :', finalUrl);
    console.log('    Título    :', title);

    const screenshotPath = path.join(OUT_DIR, 'step1_factura.png');
    await page.screenshot({ path: screenshotPath });
    console.log('    Captura   :', screenshotPath);

    if (/Attention Required|Just a moment/i.test(title)) {
      console.error('\n❌  Cloudflare sigue bloqueando el headless Playwright desde esta IP/fingerprint.');
      console.error('   Opciones:');
      console.error('   1. Proxy residencial MX: SORIANA_USE_PLAYWRIGHT_PROXY=1 + SORIANA_PROXY_URL=socks5://user:pass@host:port');
      console.error('   2. Regenerar sesión después de probar el bot una vez más');
      process.exitCode = 1;
      return;
    }

    if (/iniciar-sesion|facturacion-login/i.test(finalUrl)) {
      console.error('\n❌  Redirigió a LOGIN — la sesión Playwright expiró.');
      console.error('   → Renueva con:  node save-session.js soriana');
      process.exitCode = 1;
      return;
    }
    console.log('✅  No redirigió a login. Sesión Playwright aparentemente válida.\n');

    // ── 2. Llamada a Billing-TipoTicket (opcional) ────────────────────────────
    const testTicket = process.env.SORIANA_TEST_TICKET;
    if (!testTicket) {
      console.log('[2] SORIANA_TEST_TICKET no definido — omitiendo llamada a Billing-TipoTicket.');
      console.log('    Para probar la API: SORIANA_TEST_TICKET=1234567890 node scripts/smoke-soriana.js');
    } else {
      console.log(`[2] Llamando Billing-TipoTicket con ticket "${testTicket}"…`);
      const tipoJson = await page.evaluate(async ({ dw, ticket }) => {
        const r = await fetch(
          `${dw}/Billing-TipoTicket?ticketNo=${encodeURIComponent(ticket)}`,
          {
            method: 'GET',
            credentials: 'include',
            headers: {
              'x-requested-with': 'XMLHttpRequest',
              accept: 'application/json, text/javascript, */*; q=0.01',
            },
          }
        );
        const text = await r.text();
        try {
          return { ok: true, status: r.status, data: JSON.parse(text) };
        } catch {
          return { ok: false, status: r.status, snippet: text.slice(0, 500) };
        }
      }, { dw: DW, ticket: testTicket });

      console.log('    HTTP status:', tipoJson.status);
      if (!tipoJson.ok) {
        const sn = tipoJson.snippet || '';
        if (/blocked|GF\s*R\d+|akamai|access denied|forbidden/i.test(sn)) {
          console.error('❌  WAF/Akamai bloqueó la petición desde esta IP.');
          console.error('   → Activa un proxy residencial MX: SORIANA_USE_PLAYWRIGHT_PROXY=1 + SORIANA_PROXY_URL');
        } else {
          console.error('❌  Respuesta no-JSON:', sn);
        }
        process.exitCode = 1;
      } else {
        const r = tipoJson.data?.result;
        if (r?.success) {
          console.log('✅  Billing-TipoTicket OK:', JSON.stringify(r.data || {}));
        } else {
          const msg = r?.message || JSON.stringify(tipoJson.data);
          if (/facturado/i.test(msg)) {
            console.log('ℹ️  Ticket ya facturado (API responde bien):', msg);
          } else if (/no encontrado|not found|invalid/i.test(msg)) {
            console.log('ℹ️  Ticket no encontrado (API responde bien, sesión válida):', msg);
          } else {
            console.warn('⚠️  API respondió sin éxito:', msg);
          }
        }
      }
    }

    console.log('\n=== Smoke test finalizado ===');
  } catch (err) {
    console.error('\n❌  Error inesperado:', err.message);
    process.exitCode = 1;
  } finally {
    try { await browser?.close(); } catch (_) {}
    await teardown();
  }
}

main();
