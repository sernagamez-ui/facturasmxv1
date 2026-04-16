const { chromium } = require('playwright');
const fs = require('fs');

const URL    = process.argv[2];
const SECRET = process.argv[3];

if (!URL || !SECRET) {
  console.error('Uso: node upload-session.js <RAILWAY_URL> <ADMIN_SECRET>');
  process.exit(1);
}

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page    = await context.newPage();

  await page.goto('https://facturacion.oxxogas.com');

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Inicia sesión en el navegador.');
  console.log('  Cuando estés en /home, presiona ENTER.');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  await new Promise(r => process.stdin.once('data', r));

  const session = await context.storageState();
  fs.writeFileSync('oxxogas-session.json', JSON.stringify(session, null, 2));
  console.log(`Backup local: ${session.cookies.length} cookies`);
  await browser.close();

  console.log(`\nSubiendo a ${URL}/admin/session ...`);
  const resp = await fetch(`${URL}/admin/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': SECRET },
    body: JSON.stringify(session),
  });
  const result = await resp.json();
  console.log(resp.ok ? `✅ ${JSON.stringify(result)}` : `❌ ${JSON.stringify(result)}`);
})();
