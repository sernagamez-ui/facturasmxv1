const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { resolveDataDir } = require('./src/dataDir');
const { prepareOxxoGasPlaywrightProxy } = require('./src/proxyAgent');

(async () => {
  const dataDir = resolveDataDir();
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const sessionFile = path.join(dataDir, 'oxxogas-session.json');

  let proxyTeardown = async () => {};
  let browser;

  try {
    const prepared = await prepareOxxoGasPlaywrightProxy();
    proxyTeardown = prepared.teardown;
    const { proxy } = prepared;
    console.log(
      '[save-session] proxy:',
      proxy ? proxy.server : 'directo (sin OXXOGAS_USE_PLAYWRIGHT_PROXY=1)'
    );

    browser = await chromium.launch({
      headless: false,
      ...(proxy ? { proxy } : {}),
    });
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto('https://facturacion.oxxogas.com');

    console.log('Inicia sesión manualmente en el navegador...');
    console.log('Cuando estés en /home presiona Enter aquí.');

    await new Promise(r => process.stdin.once('data', r));

    await context.storageState({ path: sessionFile });
    console.log('Sesión guardada en', sessionFile);
    console.log('(Mismo path que usa el bot; súbelo a Railway con POST /admin/session.)');
  } finally {
    try {
      if (browser) await browser.close();
    } catch (_) {}
    await proxyTeardown();
  }
})();
