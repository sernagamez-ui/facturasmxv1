/**
 * test_portal.js — Tester universal de portales de facturación
 *
 * Invoca directamente el adaptador de un portal (sin pasar por Telegram ni OCR).
 * Muestra timing, screenshots y guarda PDF+XML si el timbrado fue exitoso.
 *
 * USO:
 *   node test_portal.js <portal> <...args> [--headful] [--debug-api] [--dry-run]
 *   node test_portal.js --list             # muestra portales disponibles y sus args
 *   node test_portal.js <portal> --help    # muestra args específicos del portal
 *
 * Portales soportados (agrégalos en PORTALES abajo):
 *   heb        <sucursal> <noTicket> <fecha> <total>
 *   petro7     <gasolinera> <folio> <webId> <fecha>
 *   oxxogas    <estacion> <noTicket> <monto> [--efectivo]
 *   walmart    <tc> <tr>
 *   soriana    <noTicket>   (requiere data/soriana-session.json)
 *   homedepot  <noTicket>
 *
 * Datos fiscales (sobreescribir con env):
 *   TEST_RFC (default SEGC9001195V8)
 *   TEST_NOMBRE (default CARLOS ALBERTO SERNA GAMEZ)
 *   TEST_CP (default 66220)
 *   TEST_REGIMEN (default 612)
 *   TEST_EMAIL (default sernagamez@gmail.com)
 *   TEST_USO (default G03)
 *
 * Ejemplos:
 *   node test_portal.js --list
 *   node test_portal.js heb --help
 *   node test_portal.js heb "HEB SAN PEDRO" 12234 2026-04-22 74.90 --headful --debug-api
 *   node test_portal.js petro7 6131 2513223 9D04 2026-04-09 --dry-run
 *   node test_portal.js walmart 220426193021 01391
 *   TEST_RFC=XAXX010101000 node test_portal.js heb "HEB LAS FUENTES" 34 2026-04-11 658
 */

/* eslint-disable no-console */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Datos fiscales por defecto ─────────────────────────────────────────────
const FISCAL = {
  rfc:     String(process.env.TEST_RFC     || 'SEGC9001195V8').toUpperCase(),
  nombre:  String(process.env.TEST_NOMBRE  || 'CARLOS ALBERTO SERNA GAMEZ'),
  cp:      String(process.env.TEST_CP      || '66220').replace(/\D/g, '').slice(0, 5),
  regimen: String(process.env.TEST_REGIMEN || '612'),
  email:   String(process.env.TEST_EMAIL   || 'sernagamez@gmail.com'),
  usoCfdi: String(process.env.TEST_USO     || 'G03'),
};

// ─── Helpers ────────────────────────────────────────────────────────────────
function normalizarFecha(fecha) {
  const s = String(fecha).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

function parseNumero(v, label) {
  const n = Number(String(v).replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} inválido: "${v}"`);
  return n;
}

function makeUserData() {
  return {
    rfc:     FISCAL.rfc,
    nombre:  FISCAL.nombre,
    cp:      FISCAL.cp,
    codigoPostal: FISCAL.cp,       // walmart usa este nombre
    regimen: FISCAL.regimen,
    email:   FISCAL.email,
    correo:  FISCAL.email,         // walmart usa este nombre
    usoCfdi: FISCAL.usoCfdi,
  };
}

function tmpOutputDir(portal) {
  const dir = path.join(__dirname, 'tmp', `${portal}_test`, String(Date.now()));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function guardarArtefactos(portal, noTicket, { xml, pdf, xmlPath, pdfPath }) {
  const outDir = path.join(__dirname, 'tmp', `${portal}_test`);
  fs.mkdirSync(outDir, { recursive: true });
  const base = `${portal}_${String(noTicket || 'factura')}_${Date.now()}`;

  const guardado = {};
  if (pdfPath && fs.existsSync(pdfPath)) {
    const dest = path.join(outDir, `${base}.pdf`);
    fs.copyFileSync(pdfPath, dest);
    guardado.pdf = dest;
  } else if (pdf && Buffer.isBuffer(pdf)) {
    const dest = path.join(outDir, `${base}.pdf`);
    fs.writeFileSync(dest, pdf);
    guardado.pdf = dest;
  }
  if (xmlPath && fs.existsSync(xmlPath)) {
    const dest = path.join(outDir, `${base}.xml`);
    fs.copyFileSync(xmlPath, dest);
    guardado.xml = dest;
  } else if (xml && (Buffer.isBuffer(xml) || typeof xml === 'string')) {
    const dest = path.join(outDir, `${base}.xml`);
    fs.writeFileSync(dest, xml);
    guardado.xml = dest;
  }
  return guardado;
}

// ─── Registro de portales ───────────────────────────────────────────────────
// Cada entrada define:
//   args       — lista de argumentos posicionales esperados (para --help y parsing)
//   envFlags   — env vars que setean --headful / --debug-api
//   parse      — convierte args CLI → invocar(args, flags) → resultado
//
// El resultado debe contener alguno de: { xml, pdf } (Buffers) o { xmlPath, pdfPath }
// junto con uuid, folio, serie si están disponibles.

const PORTALES = {
  heb: {
    args: ['sucursal', 'noTicket', 'fecha (YYYY-MM-DD o DD/MM/YYYY)', 'total'],
    envFlags: { headful: 'HEB_HEADFUL', debugApi: 'HEB_DEBUG_API' },
    async run(pos) {
      if (pos.length < 4) throw new Error('heb requiere 4 args: sucursal noTicket fecha total');
      const [sucursal, noTicket, fechaRaw, totalRaw] = pos;
      const fecha = normalizarFecha(fechaRaw);
      if (!fecha) throw new Error(`fecha no reconocida: "${fechaRaw}"`);
      const total = parseNumero(totalRaw, 'total');

      const { generarFacturaHEB } = require('./src/portales/heb');
      const ticketData = { sucursal, noTicket: String(noTicket).replace(/\D/g, ''), fecha, total };
      return generarFacturaHEB(ticketData, makeUserData());
    },
  },

  petro7: {
    args: ['gasolinera', 'folio', 'webId', 'fecha (YYYY-MM-DD)'],
    envFlags: { headful: null, debugApi: null }, // petro7 es HTTP puro, no tiene headful
    async run(pos) {
      if (pos.length < 4) throw new Error('petro7 requiere 4 args: gasolinera folio webId fecha');
      const [gasolinera, folio, webId, fechaRaw] = pos;
      const fecha = normalizarFecha(fechaRaw);
      if (!fecha) throw new Error(`fecha no reconocida: "${fechaRaw}"`);

      const { facturarPetro7 } = require('./src/portales/petro7');
      return facturarPetro7({
        gasolinera, folio, webId, fecha,
        userData: makeUserData(),
        outputDir: tmpOutputDir('petro7'),
      });
    },
  },

  oxxogas: {
    args: ['estacion', 'noTicket', 'monto', '[--efectivo]'],
    envFlags: { headful: 'OXXOGAS_HEADFUL', debugApi: null },
    async run(pos, flags) {
      if (pos.length < 3) throw new Error('oxxogas requiere 3 args: estacion noTicket monto');
      const [estacion, noTicket, montoRaw] = pos;
      const monto = parseNumero(montoRaw, 'monto');

      const { facturarOxxoGas } = require('./src/portales/oxxogas');
      return facturarOxxoGas({
        estacion,
        noTicket: String(noTicket).replace(/\D/g, ''),
        monto,
        esEfectivo: !!flags.efectivo,
        userData: makeUserData(),
        outputDir: tmpOutputDir('oxxogas'),
      });
    },
  },

  walmart: {
    args: ['TC#', 'TR#'],
    envFlags: { headful: 'WALMART_HEADFUL', debugApi: null },
    async run(pos) {
      if (pos.length < 2) throw new Error('walmart requiere 2 args: TC TR');
      const [tc, tr] = pos;
      const { facturarWalmart } = require('./src/portales/walmart');
      return facturarWalmart({ tc, tr, userData: makeUserData() });
    },
  },

  soriana: {
    args: ['noTicket'],
    envFlags: { headful: null, debugApi: null },
    async run(pos) {
      if (pos.length < 1) throw new Error('soriana requiere 1 arg: noTicket');
      const [noTicket] = pos;
      const { facturarSoriana } = require('./src/portales/soriana');
      return facturarSoriana({
        noTicket: String(noTicket).replace(/\D/g, ''),
        userData: makeUserData(),
        outputDir: tmpOutputDir('soriana'),
      });
    },
  },

  homedepot: {
    args: ['noTicket'],
    envFlags: { headful: 'HOMEDEPOT_HEADFUL', debugApi: null },
    async run(pos) {
      if (pos.length < 1) throw new Error('homedepot requiere 1 arg: noTicket');
      const [noTicket] = pos;
      const { facturarHomeDepot } = require('./src/portales/homedepot');
      return facturarHomeDepot({
        noTicket: String(noTicket).replace(/\D/g, ''),
        userData: makeUserData(),
        outputDir: tmpOutputDir('homedepot'),
      });
    },
  },
};

// ─── CLI ────────────────────────────────────────────────────────────────────
function listarPortales() {
  console.log('\nPortales disponibles:\n');
  for (const [name, cfg] of Object.entries(PORTALES)) {
    console.log(`  ${name.padEnd(10)} ${cfg.args.join(' ')}`);
  }
  console.log('\nFlags globales: --headful --debug-api --dry-run --inspect\n');
  console.log('  --inspect  activa Playwright Inspector + DevTools + timeouts de 1h + browser queda abierto al fallar');
  console.log('');
  console.log('Datos fiscales via env: TEST_RFC TEST_NOMBRE TEST_CP TEST_REGIMEN TEST_EMAIL TEST_USO\n');
}

function mostrarAyudaPortal(portal) {
  const cfg = PORTALES[portal];
  if (!cfg) return listarPortales();
  console.log(`\nUso: node test_portal.js ${portal} ${cfg.args.join(' ')} [flags]\n`);
  console.log('Flags:');
  if (cfg.envFlags.headful)  console.log(`  --headful     (${cfg.envFlags.headful}=1)`);
  if (cfg.envFlags.debugApi) console.log(`  --debug-api   (${cfg.envFlags.debugApi}=1)`);
  console.log('  --dry-run     Solo valida argumentos, no invoca el portal\n');
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--list' || args[0] === '-l') {
    listarPortales();
    process.exit(0);
  }

  const portal = args[0].toLowerCase();
  const rest   = args.slice(1);

  if (!PORTALES[portal]) {
    console.error(`[test_portal] portal desconocido: "${portal}"`);
    listarPortales();
    process.exit(1);
  }

  if (rest.includes('--help') || rest.includes('-h')) {
    mostrarAyudaPortal(portal);
    process.exit(0);
  }

  const cfg     = PORTALES[portal];
  const flags   = {
    headful:  rest.includes('--headful'),
    debugApi: rest.includes('--debug-api'),
    dry:      rest.includes('--dry-run'),
    efectivo: rest.includes('--efectivo'),
    inspect:  rest.includes('--inspect'),
  };

  // --inspect implica --headful --debug-api y activa Playwright Inspector
  if (flags.inspect) {
    flags.headful  = true;
    flags.debugApi = true;

    // Playwright Inspector: browser queda abierto, se puede step-debug con DevTools
    // + botones de "Resume/Step over" en la UI del inspector.
    process.env.PWDEBUG = '1';

    // Timeouts infinitos para poder inspeccionar sin que expire
    process.env.HEB_TIMBRADO_MS        = '3600000'; // 1h
    process.env.HEB_TIMEOUT_CONSULTA_MS = '3600000';

    console.log('[test_portal] 🔍 modo --inspect activado:');
    console.log('  • Browser abierto (headful)');
    console.log('  • Playwright Inspector visible (controla pausa/step/resume)');
    console.log('  • DevTools disponibles en el browser del portal');
    console.log('  • Timeouts extendidos a 1h para inspección manual');
    console.log('  • Al terminar: presiona Enter aquí para cerrar\n');
  }

  if (flags.headful  && cfg.envFlags.headful)  process.env[cfg.envFlags.headful]  = '1';
  if (flags.debugApi && cfg.envFlags.debugApi) process.env[cfg.envFlags.debugApi] = '1';

  const pos = rest.filter((a) => !a.startsWith('--'));

  console.log(`[test_portal] portal=${portal}`);
  console.log(`[test_portal] args  =${JSON.stringify(pos)}`);
  console.log(`[test_portal] flags =${JSON.stringify(flags)}`);
  console.log(`[test_portal] rfc   =${FISCAL.rfc} cp=${FISCAL.cp} email=${FISCAL.email}`);

  if (flags.dry) {
    console.log('[test_portal] --dry-run: no se invoca al portal.');
    process.exit(0);
  }

  const tStart = Date.now();
  try {
    const r = await cfg.run(pos, flags);
    const ms = ((Date.now() - tStart) / 1000).toFixed(1);

    // Éxito si retornó xml/pdf o xmlPath/pdfPath
    const tieneArtefactos = !!(r?.xml || r?.pdf || r?.xmlPath || r?.pdfPath);
    const okFlag = r?.ok !== false && (tieneArtefactos || !!r?.uuid);

    if (!okFlag) {
      console.error(`[test_portal] ❌ FALLO (${ms}s)`);
      console.error('[test_portal] resultado:', JSON.stringify(r, null, 2).substring(0, 2000));
      process.exit(2);
    }

    const noTicketRef = pos.find((p) => /^\d{3,}$/.test(String(p))) || r?.folio || 'factura';
    const guardado = guardarArtefactos(portal, noTicketRef, r);

    console.log(`[test_portal] ✅ OK (${ms}s)`);
    if (r.uuid)  console.log('[test_portal] UUID :', r.uuid);
    if (r.folio) console.log('[test_portal] Folio:', r.folio);
    if (r.serie) console.log('[test_portal] Serie:', r.serie);
    if (guardado.pdf) console.log('[test_portal] PDF  :', guardado.pdf);
    if (guardado.xml) console.log('[test_portal] XML  :', guardado.xml);
    process.exit(0);
  } catch (err) {
    const ms = ((Date.now() - tStart) / 1000).toFixed(1);
    console.error(`[test_portal] ❌ EXCEPCIÓN (${ms}s):`, err.message);
    console.error('[test_portal] revisa screenshots en /tmp/*_step*.png');

    if (flags.inspect) {
      console.log('\n[test_portal] 🔍 modo --inspect: el browser NO se cerró.');
      console.log('  Abre DevTools en el browser del portal (Cmd+Opt+I) y debuggea.');
      console.log('  Presiona Enter en esta terminal cuando termines para salir.\n');
      await new Promise((r) => process.stdin.once('data', r));
    }
    process.exit(3);
  }
}

main().catch((e) => {
  console.error('[test_portal] fatal:', e);
  process.exit(4);
});
