/**
 * test_walmart.js — Prueba local del adaptador Playwright (facturacion.walmartmexico.com.mx)
 *
 * Genera una solicitud REAL de factura por correo si no usas --dry-run.
 * Úsalo con un ticket vigente y datos fiscales correctos.
 *
 * USO:
 *   node test_walmart.js <TC#> <TR#> [--dry-run] [--headful]
 *
 *   TC#  = dígitos del código bajo "TC#" (barra inferior del ticket)
 *   TR#  = dígitos de "TR#" / transacción
 *
 * Datos fiscales (por defecto los del test_homedepot; sobreescribe con env):
 *   WALMART_TEST_RFC, WALMART_TEST_CP, WALMART_TEST_REGIMEN, WALMART_TEST_EMAIL,
 *   WALMART_TEST_NOMBRE, WALMART_TEST_USO (ej. G03)
 *
 * Ejemplos:
 *   node test_walmart.js 220426193021 01391 --dry-run
 *   node test_walmart.js 74332314121182720306 00986 --headful
 *   WALMART_USE_PROXY=1 node test_walmart.js ...
 */

/* eslint-disable no-console */

const { facturarWalmart } = require('./src/portales/walmart');

const DEFAULT = {
  rfc: String(process.env.WALMART_TEST_RFC || 'SEGC9001195V8').toUpperCase(),
  nombre: String(process.env.WALMART_TEST_NOMBRE || 'CARLOS ALBERTO SERNA GAMEZ'),
  cp: String(process.env.WALMART_TEST_CP || '66220').replace(/\D/g, '').slice(0, 5),
  regimen: String(process.env.WALMART_TEST_REGIMEN || '612'),
  correo: String(process.env.WALMART_TEST_EMAIL || 'sernagamez@gmail.com'),
  usoCfdi: String(process.env.WALMART_TEST_USO || 'G03'),
};

function usage() {
  console.log(`
Uso: node test_walmart.js <TC#> <TR#> [--dry-run] [--headful]

  --dry-run   Solo valida argumentos y datos; no abre el navegador
  --headful   Misma variable que WALMART_HEADFUL=1 (ver el browser)

Requiere un ticket *no facturado* y ventana de tiempo válida en el portal.
`);
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const dry = args.includes('--dry-run');
  if (args.includes('--headful')) process.env.WALMART_HEADFUL = '1';

  const pos = args.filter((a) => !a.startsWith('--'));
  if (pos.length < 2) {
    usage();
    process.exit(1);
  }

  const [tc, tr] = pos;
  const userData = {
    rfc: DEFAULT.rfc,
    nombre: DEFAULT.nombre,
    codigoPostal: DEFAULT.cp,
    regimen: DEFAULT.regimen,
    correo: DEFAULT.correo,
    usoCfdi: DEFAULT.usoCfdi,
  };

  console.log('[test_walmart] TC =', String(tc).replace(/\D/g, ''), 'TR =', String(tr).replace(/\D/g, ''));
  console.log('[test_walmart] RFC =', userData.rfc, 'CP =', userData.codigoPostal, 'correo =', userData.correo);
  if (dry) {
    console.log('[test_walmart] --dry-run: no se invoca al portal.');
    process.exit(0);
  }

  const r = await facturarWalmart({ tc, tr, userData });
  if (r.ok) {
    console.log('[test_walmart] OK:', r);
    process.exit(0);
  }
  console.error('[test_walmart] FALLO:', r.error, r.userMessage);
  process.exit(2);
}

main().catch((e) => {
  console.error('[test_walmart] excepción:', e);
  process.exit(3);
});
