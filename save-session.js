const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { resolveDataDir } = require('./src/dataDir');
const { prepareOxxoGasPlaywrightProxy } = require('./src/proxyAgent');

const portal = (process.argv[2] || 'oxxogas').toLowerCase();

const PORTALS = {
  oxxogas: {
    startUrl: 'https://facturacion.oxxogas.com',
    sessionFile: 'oxxogas-session.json',
    useOxxogasProxy: true,
    hint: 'Cuando estés en /home presiona Enter aquí.',
    adminNote: 'POST /admin/session (oxxogas-session.json)',
  },
  soriana: {
    startUrl: 'https://www.soriana.com/iniciar-sesion?fromFacturacion=true',
    sessionFile: 'soriana-session.json',
    useOxxogasProxy: false,
    hint:
      'Completa login (SMS/código) en Soriana. Cuando puedas abrir Facturación electrónica logueado, presiona Enter aquí.',
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
    }

    browser = await chromium.launch({
      headless: false,
      ...(proxy ? { proxy } : {}),
    });
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(cfg.startUrl);

    console.log(`\n[save-session] Portal: ${portal}`);
    console.log(cfg.hint);
    console.log(`Archivo: ${sessionFile}`);
    console.log(`(${cfg.adminNote})\n`);

    await new Promise(r => process.stdin.once('data', r));

    await context.storageState({ path: sessionFile });
    console.log('Sesión guardada en', sessionFile);
  } finally {
    try {
      if (browser) await browser.close();
    } catch (_) {}
    await proxyTeardown();
  }
})();
