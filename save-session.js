const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { resolveDataDir } = require('./src/dataDir');
const { prepareOxxoGasPlaywrightProxy, prepareSorianaPlaywrightProxy } = require('./src/proxyAgent');

const portal = (process.argv[2] || 'oxxogas').toLowerCase();

/** Misma URL que en src/portales/soriana.js — evita tener que abrir el enlace del pie a mano. */
const SORIANA_FACTURA_URL = 'https://www.soriana.com/facturacionelectronica#FacturarCompra';

const PORTALS = {
  oxxogas: {
    startUrl: 'https://facturacion.oxxogas.com',
    sessionFile: 'oxxogas-session.json',
    useOxxogasProxy: true,
    hint: 'Cuando estés en /home presiona Enter aquí.',
    adminNote: 'POST /admin/session (oxxogas-session.json)',
  },
  soriana: {
    startUrl: SORIANA_FACTURA_URL,
    sessionFile: 'soriana-session.json',
    useOxxogasProxy: false,
    /** Cloudflare bloquea a menudo el Chromium embebido; usamos Chrome/Edge del sistema. */
    useSystemBrowserChannel: true,
    /** Tras Enter, navegamos a facturación por código (mismo criterio que el bot; no hace falta el enlace del pie). */
    afterEnterGoto: SORIANA_FACTURA_URL,
    hint:
      'Chrome de tu Mac. 1) Pasa el captcha e inicia sesión (si pide ir a inicio, no importa). 2) Enter aquí: el script abre Facturación electrónica por ti y guarda la sesión.',
    adminNote: 'POST /admin/session/soriana (soriana-session.json)',
  },
};

(async () => {
  const cfg = PORTALS[portal];
  if (!cfg) {
    console.error(`Portal desconocido: ${portal}. Usa: oxxogas | soriana`);
    process.exit(1);
  }

  const dataDir = resolveDataDir();
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const sessionFile = path.join(dataDir, cfg.sessionFile);

  let proxyTeardown = async () => {};
  let browser;
  let proxy;

  try {
    if (cfg.useOxxogasProxy) {
      const prepared = await prepareOxxoGasPlaywrightProxy();
      proxyTeardown = prepared.teardown;
      proxy = prepared.proxy;
      console.log(
        '[save-session] proxy:',
        proxy ? proxy.server : 'directo (sin OXXOGAS_USE_PLAYWRIGHT_PROXY=1)'
      );
    } else if (portal === 'soriana' && String(process.env.SORIANA_USE_PLAYWRIGHT_PROXY || '').trim() === '1') {
      const prepared = await prepareSorianaPlaywrightProxy();
      proxyTeardown = prepared.teardown;
      proxy = prepared.proxy;
      console.log(
        '[save-session] proxy Soriana:',
        proxy ? proxy.server : '(SORIANA_USE_PLAYWRIGHT_PROXY=1 pero sin URL — revisa SORIANA_PROXY_URL / PROXY_URL_SOCKS5 / PROXY_URL_STICKY)'
      );
    }

    const launchBase = {
      headless: false,
      ...(proxy ? { proxy } : {}),
    };

    if (cfg.useSystemBrowserChannel) {
      const channel =
        process.env.SORIANA_SAVE_SESSION_CHANNEL || 'chrome';
      const args = ['--disable-blink-features=AutomationControlled'];
      try {
        browser = await chromium.launch({
          ...launchBase,
          channel,
          args,
        });
        console.log(`[save-session] Navegador: channel=${channel} (mejor para Cloudflare/Soriana)`);
      } catch (e) {
        console.warn(
          `[save-session] No se pudo abrir channel=${channel} (${e.message}). ¿Tienes Chrome instalado? Probando Chromium embebido (Cloudflare puede fallar).`
        );
        browser = await chromium.launch({ ...launchBase, args });
      }
    } else {
      browser = await chromium.launch(launchBase);
    }
    const context =
      portal === 'soriana'
        ? await browser.newContext({ viewport: { width: 1360, height: 900 } })
        : await browser.newContext();
    const page = await context.newPage();

    await page.goto(cfg.startUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });

    console.log(`\n[save-session] Portal: ${portal}`);
    console.log(cfg.hint);
    console.log(`Archivo: ${sessionFile}`);
    console.log(`(${cfg.adminNote})\n`);

    await new Promise(r => process.stdin.once('data', r));

    if (cfg.afterEnterGoto) {
      console.log('\n[save-session] Navegando a Facturación electrónica (igual que el bot)...');
      try {
        await page.goto(cfg.afterEnterGoto, { waitUntil: 'domcontentloaded', timeout: 120_000 });
        await new Promise((r) => setTimeout(r, 2500));
      } catch (e) {
        console.warn('[save-session] Aviso al abrir facturación:', e.message, '(se guarda la sesión igual).');
      }
    }

    await context.storageState({ path: sessionFile });
    console.log('Sesión guardada en', sessionFile);
  } finally {
    try {
      if (browser) await browser.close();
    } catch (_) {}
    await proxyTeardown();
  }
})();
