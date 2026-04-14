const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://facturacion.oxxogas.com');
  
  console.log('Inicia sesión manualmente en el navegador...');
  console.log('Cuando estés en /home presiona Enter aquí.');
  
  await new Promise(r => process.stdin.once('data', r));
  
  await context.storageState({ path: 'oxxogas-session.json' });
  console.log('Sesión guardada en oxxogas-session.json');
  
  await browser.close();
})();
