#!/usr/bin/env node
/**
 * Prueba local del adaptador HEB con capturas en tmp/heb-debug/
 *
 * 1) Copia datos de prueba (no subas RFC reales a git; usa .env local):
 *    HEB_TEST_RFC=... HEB_TEST_NOMBRE=... HEB_TEST_CP=64000 HEB_TEST_EMAIL=...
 *    HEB_TEST_SUCURSAL="HEB SAN PEDRO" HEB_TEST_TICKET=1195 HEB_TEST_FECHA=2026-04-20 HEB_TEST_TOTAL=85
 *
 * 2) Ejecuta desde la raíz del repo:
 *    npm run smoke:heb
 *
 *    Navegador visible (defecto): ves el flujo en vivo.
 *    Sin UI: HEB_HEADFUL=0 npm run smoke:heb
 *
 * Capturas: tmp/heb-debug/heb_step0.png … step7.png (o HEB_SCREENSHOT_DIR)
 */

require('dotenv').config();

const fs   = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'tmp', 'heb-debug');

fs.mkdirSync(outDir, { recursive: true });
process.env.HEB_SCREENSHOT_DIR = process.env.HEB_SCREENSHOT_DIR || outDir;

if (process.env.HEB_HEADFUL === undefined) process.env.HEB_HEADFUL = '1';

const ticketData = {
  sucursal: process.env.HEB_TEST_SUCURSAL || 'HEB SAN PEDRO',
  noTicket: process.env.HEB_TEST_TICKET || '1195',
  fecha:    process.env.HEB_TEST_FECHA || '2026-04-20',
  total:    Number(process.env.HEB_TEST_TOTAL || '85'),
};

const userData = {
  rfc:     process.env.HEB_TEST_RFC || '',
  nombre:  process.env.HEB_TEST_NOMBRE || '',
  cp:      process.env.HEB_TEST_CP || '',
  regimen: process.env.HEB_TEST_REGIMEN || '601',
  email:   process.env.HEB_TEST_EMAIL || '',
  usoCfdi: process.env.HEB_TEST_USO_CFDI || 'G03',
};

async function main() {
  const missing = ['HEB_TEST_RFC', 'HEB_TEST_NOMBRE', 'HEB_TEST_CP', 'HEB_TEST_EMAIL'].filter(
    (k) => !process.env[k]
  );
  if (missing.length) {
    console.error('Faltan variables en .env o en el entorno:', missing.join(', '));
    console.error('Ejemplo en la raíz del proyecto (.env local, no commitear):');
    console.error(
      'HEB_TEST_RFC=XXXX HEB_TEST_NOMBRE="RAZON" HEB_TEST_CP=64000 HEB_TEST_EMAIL=a@b.com'
    );
    process.exit(1);
  }

  console.log('Screenshots →', process.env.HEB_SCREENSHOT_DIR);
  console.log('HEB_HEADFUL =', process.env.HEB_HEADFUL, '(1 = ventana visible)');
  console.log('Ticket:', ticketData.sucursal, ticketData.noTicket, ticketData.fecha, ticketData.total);

  const { generarFacturaHEB } = require('../src/portales/heb');
  const r = await generarFacturaHEB(ticketData, userData);
  console.log('OK — uuid:', r.uuid, 'folio:', r.folio, 'serie:', r.serie);
  console.log('PDF/XML en buffers (no guardados en disco por este script).');
}

main().catch((e) => {
  console.error(e.message || e);
  console.error('\nRevisa las capturas en:', process.env.HEB_SCREENSHOT_DIR);
  process.exit(1);
});
