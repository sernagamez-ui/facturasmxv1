// test_officedepot.js
// Script standalone de diagnóstico para el portal de facturación Office Depot.
// Metodología Fase 2: ejecutar cada paso del flujo con logs detallados,
// sin tocar Telegram ni ningún otro módulo del bot.
//
// Uso:
//   node test_officedepot.js
//
// Antes de correr, ajustar el objeto TICKET con datos reales del ticket.
// Office Depot es un API REST puro (sin auth, sin cookies, sin CSRF).
// Flujo confirmado por HAR:
//   1. GET  /configuration/getParamMaintenance        → check portal activo
//   2. POST /invorch/invoicingOrch/validateItu        → valida ITU, devuelve billingId
//   3. POST /invorch/invoicingOrch/getRfcStatus       → check RFC
//   4. POST /invorch/invoicingOrch/getClientData      → datos previos del cliente
//   5. POST /catalogs/catalogs/getStateList           → CP → estado
//   6. POST /catalogs/catalogs/getMunicipalityList    → CP → municipio
//   7. POST /catalogs/catalogs/getSuburbList          → CP → colonias
//   8. POST /consult/consult/validRfc                 → valida RFC+razón social+CP vs SAT
//   9. POST /invorch/invoicingOrch/emitInvoice        → emite CFDI (llega por EMAIL, no en respuesta)

const axios = require('axios');

const BASE = 'https://facturacion.officedepot.com.mx/facturacion-emision';
const HEADERS_JSON = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/plain, */*',
  'Origin': 'https://facturacion.officedepot.com.mx',
  'Referer': 'https://facturacion.officedepot.com.mx/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
};
const HEADERS_TEXT = { ...HEADERS_JSON, 'Content-Type': 'text/plain' };

// ============================================================================
// DATOS DEL TICKET Y DEL USUARIO — REEMPLAZAR CON VALORES REALES PARA PROBAR
// ============================================================================
const TICKET = {
  itu: '20240723005011010000009­46POSA9', // 30 caracteres, termina en POSA#
  amount: 11, // total del ticket (en el HAR iba 11, pero el portal parece tolerante para xstore=S)
};

const USUARIO = {
  rfc: 'SEGC9001195V8',
  type: 'F', // 'F' persona física, 'M' persona moral
  name: 'CARLOS ALBERTO',
  paternalSurname: 'SERNA',
  maternalSurname: 'GAMEZ',
  businessName: 'CARLOS ALBERTO SERNA GAMEZ', // para validRfc (nombre completo tal como SAT)
  email: 'sernagamez@gmail.com',
  zipCode: '66220',
  regimenFiscal: '612', // 612, 626, 601, etc.
  useCfdi: 'G03', // G03 gastos generales, G01 mercancía reventa, S01 sin efectos
};
// ============================================================================

// Helper para imprimir cada paso
function log(step, title) {
  console.log('\n' + '='.repeat(78));
  console.log(`PASO ${step}: ${title}`);
  console.log('='.repeat(78));
}

function dump(label, data) {
  console.log(`\n[${label}]`);
  console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}

async function post(path, body, headers = HEADERS_JSON) {
  try {
    const res = await axios.post(`${BASE}${path}`, body, { headers, timeout: 30000 });
    return { ok: true, status: res.status, data: res.data };
  } catch (err) {
    return {
      ok: false,
      status: err.response?.status,
      data: err.response?.data,
      message: err.message,
    };
  }
}

async function get(path, headers = HEADERS_JSON) {
  try {
    const res = await axios.get(`${BASE}${path}`, { headers, timeout: 30000 });
    return { ok: true, status: res.status, data: res.data };
  } catch (err) {
    return { ok: false, status: err.response?.status, data: err.response?.data, message: err.message };
  }
}

// Normalizar ITU: Vision puede confundir O (letra) con 0 (cero) en "POSA"
function normalizeItu(raw) {
  // Formato garantizado: [28 dígitos/letras] + "POSA" + [1 dígito]
  // Los últimos 5 chars desde -5 deben ser "POSA" + dígito
  if (!raw) return raw;
  const clean = raw.trim().toUpperCase().replace(/[\s-]/g, '');
  if (clean.length !== 30) {
    console.warn(`[WARN] ITU tiene ${clean.length} caracteres, esperados 30.`);
  }
  // Forzar POSA en posiciones 25-28 (0-indexed: 25,26,27,28)
  const prefix = clean.slice(0, 25);
  const tail = clean.slice(25); // debería ser "POSA" + digito
  const fixedTail = 'POSA' + (tail[4] || '');
  return prefix + fixedTail;
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════════════════════╗');
  console.log('║          DIAGNÓSTICO PORTAL OFFICE DEPOT — test_officedepot.js             ║');
  console.log('╚════════════════════════════════════════════════════════════════════════════╝');

  const itu = normalizeItu(TICKET.itu);
  console.log(`\nITU original:   ${TICKET.itu}`);
  console.log(`ITU normalizado: ${itu}`);
  console.log(`RFC:            ${USUARIO.rfc}`);
  console.log(`Monto ticket:   $${TICKET.amount}`);

  // ─────────────────────────────────────────────────────────────────────────
  log(1, 'Verificar que el portal no está en mantenimiento');
  // ─────────────────────────────────────────────────────────────────────────
  const maint = await get('/configuration/getParamMaintenance');
  dump('Respuesta', maint);
  if (maint.data?.configValue === '1') {
    console.error('❌ Portal en mantenimiento. Abortar.');
    process.exit(1);
  }
  console.log('✅ Portal operativo.');

  // ─────────────────────────────────────────────────────────────────────────
  log(2, 'Validar ITU del ticket');
  // ─────────────────────────────────────────────────────────────────────────
  const validatePayload = {
    billingId: 0,
    auxBillingId: 0,
    itu: itu,
    amount: TICKET.amount,
    listItus: [],
    xstore: '',
    series: [],
    totalItus: 0,
    typeOrder: '1',
    company: 'OD',
  };
  dump('Request body', validatePayload);
  const validate = await post('/invorch/invoicingOrch/validateItu', validatePayload);
  dump('Response', validate);
  if (!validate.ok || !validate.data?.status) {
    console.error('❌ Validación de ITU falló. Posibles causas:');
    console.error('   - ITU inválido o ya facturado');
    console.error('   - Ticket fuera de plazo (solo se puede facturar hasta fin del mes de compra)');
    console.error('   - Monto incorrecto');
    process.exit(1);
  }
  const billingId = validate.data.object.billingId;
  const xstore = validate.data.object.xstore;
  const origen = validate.data.object.origen;
  console.log(`✅ billingId=${billingId}, xstore=${xstore}, origen=${origen}`);

  // ─────────────────────────────────────────────────────────────────────────
  log(3, 'Consultar estatus del RFC en el portal');
  // ─────────────────────────────────────────────────────────────────────────
  const rfcStatus = await post('/invorch/invoicingOrch/getRfcStatus', { rfc: USUARIO.rfc });
  dump('Response', rfcStatus);
  if (!rfcStatus.ok || !rfcStatus.data?.status) {
    console.error('❌ getRfcStatus falló.');
    process.exit(1);
  }
  console.log('✅ RFC consultado.');

  // ─────────────────────────────────────────────────────────────────────────
  log(4, 'Traer datos previos del cliente (si existe)');
  // ─────────────────────────────────────────────────────────────────────────
  const clientData = await post('/invorch/invoicingOrch/getClientData', { rfc: USUARIO.rfc });
  dump('Response', clientData);
  const existente = clientData.data?.object?.name != null;
  console.log(existente ? '✅ Cliente existente en Office Depot.' : 'ℹ️  Cliente nuevo — Office Depot lo creará al emitir.');

  // ─────────────────────────────────────────────────────────────────────────
  log(5, 'Resolver estado/municipio/colonia por CP');
  // ─────────────────────────────────────────────────────────────────────────
  const stateRes = await post('/catalogs/catalogs/getStateList', USUARIO.zipCode, HEADERS_TEXT);
  dump('getStateList', stateRes.data);
  const muniRes = await post('/catalogs/catalogs/getMunicipalityList', USUARIO.zipCode, HEADERS_TEXT);
  dump('getMunicipalityList', muniRes.data);
  const subRes = await post('/catalogs/catalogs/getSuburbList', USUARIO.zipCode, HEADERS_TEXT);
  dump('getSuburbList', subRes.data);
  if (!stateRes.ok || !stateRes.data?.status) {
    console.error('❌ CP inválido o portal rechaza el CP.');
    process.exit(1);
  }
  console.log('✅ CP resuelto.');

  // ─────────────────────────────────────────────────────────────────────────
  log(6, 'Validar RFC+razón social+CP+régimen contra SAT');
  // ─────────────────────────────────────────────────────────────────────────
  const validRfcPayload = {
    businessName: USUARIO.businessName,
    postalCode: USUARIO.zipCode,
    regimenFiscal: USUARIO.regimenFiscal,
    rfc: USUARIO.rfc,
  };
  dump('Request body', validRfcPayload);
  const validRfc = await post('/consult/consult/validRfc', validRfcPayload);
  dump('Response', validRfc);
  if (!validRfc.ok || !validRfc.data?.status) {
    console.error('❌ SAT rechazó los datos fiscales. Revisar:');
    console.error('   - Nombre exactamente como aparece en Constancia de Situación Fiscal');
    console.error('   - CP fiscal (no el de envío)');
    console.error('   - Régimen correcto (612/626/601/etc.)');
    process.exit(1);
  }
  console.log('✅ SAT validó razón social + CP + régimen.');

  // ─────────────────────────────────────────────────────────────────────────
  log(7, 'Emitir la factura (llega por EMAIL)');
  // ─────────────────────────────────────────────────────────────────────────
  const emitPayload = {
    iepsRequired: 'N',
    rfc: USUARIO.rfc,
    type: USUARIO.type,
    name: USUARIO.name,
    paternalSurname: USUARIO.paternalSurname,
    maternalSurname: USUARIO.maternalSurname,
    email: USUARIO.email,
    street: '',
    outerNumber: '',
    innerNumber: '',
    zipCode: USUARIO.zipCode,
    colony: '',
    colonyText: '',
    nocolony: '',
    state: '',
    municipality: '',
    useCfdi: USUARIO.useCfdi,
    regimenFiscal: USUARIO.regimenFiscal,
    nacional: 'S',
    numRegId: '',
    fiscalResidence: '',
    solounico: '',
    idTransaction: billingId,
    paymentMethod: 0,
    idTransactionAux: '0',
    xstore: xstore,
    origen: origen,
  };
  dump('Request body', emitPayload);
  const emit = await post('/invorch/invoicingOrch/emitInvoice', emitPayload);
  dump('Response', emit);

  if (!emit.ok || !emit.data?.status) {
    console.error('❌ emitInvoice falló.');
    console.error('   errorMsg:', emit.data?.object?.errorMsg);
    process.exit(1);
  }

  console.log('\n╔════════════════════════════════════════════════════════════════════════════╗');
  console.log('║  ✅ FACTURA EMITIDA                                                        ║');
  console.log('╚════════════════════════════════════════════════════════════════════════════╝');
  console.log(`newItu: ${emit.data.object.newItu}`);
  console.log(`\n⚠️  IMPORTANTE: Office Depot NO devuelve XML/PDF en la respuesta HTTP.`);
  console.log(`   La factura llega al correo registrado: ${USUARIO.email}`);
  console.log(`   Para que Cotas entregue XML+PDF por Telegram se requiere`);
  console.log(`   buzón catch-all con webhook (ver propuesta arquitectónica).`);
}

main().catch((err) => {
  console.error('\n❌ Error inesperado:');
  console.error(err);
  process.exit(1);
});
