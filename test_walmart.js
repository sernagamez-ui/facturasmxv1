/**
 * test_walmart_adapter.js — runner standalone para src/portales/walmart.js
 *
 * Prueba el adaptador de producción sin pasar por Telegraf / facturaRouter.
 * Si falla, tienes el stacktrace exacto; si pasa, el archivo está listo para
 * integrarse al bot con una línea en facturaRouter.js.
 *
 * USO:
 *   WALMART_HEADFUL=1 WALMART_TC=<20_digitos> WALMART_TR=<tr> node test_walmart_adapter.js
 *
 *   # Con override de usuario y tiempos largos para tickets lentos:
 *   WALMART_HEADFUL=1 WALMART_POST_FISCAL_MS=300000 WALMART_SCREENSHOT_DIR=/tmp \
 *     WALMART_TC=35355039334561586306 WALMART_TR=01391 \
 *     node test_walmart_adapter.js 2>&1 | tee /tmp/walmart.log
 */

'use strict';

const { facturarWalmart } = require('./src/portales/walmart');

const TICKET = {
  tc: process.env.WALMART_TC || process.argv[2] || '35355039334561586306',
  tr: process.env.WALMART_TR || process.argv[3] || '01391',
};

const USUARIO = {
  rfc:          process.env.WALMART_RFC    || 'SEGC9001195V8',
  nombre:       process.env.WALMART_NOMBRE || 'CARLOS ALBERTO SERNA GAMEZ',
  cp:           process.env.WALMART_CP     || '66220',
  correo:       process.env.WALMART_EMAIL  || 'sernagamez@gmail.com',
  regimen:      process.env.WALMART_REGIMEN || '612',
  usoCfdi:      process.env.WALMART_USO    || 'G03',
};

(async () => {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   TEST ADAPTER — src/portales/walmart.js                     ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`TC=${TICKET.tc} (${TICKET.tc.length} dígitos)  TR=${TICKET.tr}`);
  console.log(`RFC=${USUARIO.rfc}  CP=${USUARIO.cp}  régimen=${USUARIO.regimen}`);
  console.log();

  const t0 = Date.now();
  try {
    const res = await facturarWalmart({
      tc: TICKET.tc,
      tr: TICKET.tr,
      userData: USUARIO,
    });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log();
    console.log(`───── RESULTADO (${elapsed}s) ─────`);
    console.log(JSON.stringify(res, null, 2));
    if (res.ok) {
      console.log('\n✅ ÉXITO — revisa tu correo por el XML/PDF');
      process.exit(0);
    } else {
      console.log(`\n❌ FALLÓ — error=${res.error}`);
      console.log(`   userMessage: ${res.userMessage}`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`\n💥 EXCEPCIÓN sin catch en walmart.js:`, e);
    process.exit(2);
  }
})();
