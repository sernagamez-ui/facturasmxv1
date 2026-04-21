const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { resolveDataDir } = require('./src/dataDir');

(async () => {
  const dataDir = resolveDataDir();
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const sessionFile = path.join(dataDir, 'oxxogas-session.json');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://facturacion.oxxogas.com');

  console.log('Inicia sesión manualmente en el navegador...');
  console.log('Cuando estés en /home presiona Enter aquí.');

  await new Promise(r => process.stdin.once('data', r));

  await context.storageState({ path: sessionFile });
  console.log('Sesión guardada en', sessionFile);
  console.log('(Mismo path que usa el bot; súbelo a Railway con POST /admin/session.)');

  await browser.close();
})();
