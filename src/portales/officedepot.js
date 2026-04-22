// src/portales/officedepot.js
//
// Adaptador de facturación Office Depot México.
// HTTP puro con axios — sin Playwright, sin cookies, sin auth.
//
// Flujo confirmado por HAR + test_officedepot.js:
//   1. GET  /configuration/getParamMaintenance      (portal operativo)
//   2. POST /invorch/invoicingOrch/validateItu      (valida ticket, devuelve billingId)
//   3. POST /invorch/invoicingOrch/getRfcStatus     (informativo)
//   4. POST /invorch/invoicingOrch/getClientData    (informativo, replica browser)
//   5. POST /catalogs/catalogs/getStateList         (body: CP en text/plain)
//   6. POST /catalogs/catalogs/getMunicipalityList  (body: CP en text/plain)
//   7. POST /catalogs/catalogs/getSuburbList        (body: CP en text/plain)
//   8. POST /consult/consult/validRfc               (valida RFC+nombre+CP+régimen vs SAT)
//   9. POST /invorch/invoicingOrch/emitInvoice      (emite CFDI — llega al email)
//
// emitInvoice.email: un solo campo. Usamos {telegramId}@factural.mx para que el CFDI
// llegue por correo a Cloudflare → Worker POST /webhooks/email → XML/PDF al chat.

const axios = require('axios');

const BASE = 'https://facturacion.officedepot.com.mx/facturacion-emision';
const TIMEOUT_MS = 30000;

const HEADERS_JSON = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/plain, */*',
  Origin: 'https://facturacion.officedepot.com.mx',
  Referer: 'https://facturacion.officedepot.com.mx/',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
};
const HEADERS_TEXT = { ...HEADERS_JSON, 'Content-Type': 'text/plain' };

const log = (...a) => console.log('[officedepot]', ...a);
const logErr = (...a) => console.error('[officedepot]', ...a);

function normalizeItu(raw) {
  if (!raw) return '';
  let s = String(raw).toUpperCase();
  // OCR suele leer "POSA" como "P0SA" (cero en lugar de O).
  s = s.replace(/P0SA/gi, 'POSA');
  const clean = s.replace(/[^A-Z0-9]/g, '');
  if (clean.length !== 30) return clean;
  return clean.slice(0, 25) + 'POSA' + clean.slice(29);
}

/**
 * Mapea datos del onboarding Cotas al payload Office Depot.
 * @param {object} userData — rfc, nombre, cp, regimen, email (personal; no se usa en portal si pasas portalEmail)
 * @param {string} portalEmail — típicamente `{telegramId}@factural.mx`
 */
function buildUsuario(userData, portalEmail) {
  const rfc = String(userData.rfc || '')
    .trim()
    .toUpperCase();
  const nombreRaw = String(userData.nombre || '').trim().replace(/\s+/g, ' ');
  const regimenFiscal = String(userData.regimen || '').replace(/\D/g, '');
  const zipCode = String(userData.cp || '').trim();
  const useCfdi = userData.usoCFDI || userData.usoCfdi || 'G03';
  const email = String(portalEmail || userData.email || '')
    .trim()
    .toLowerCase();

  const nombre = nombreRaw.toUpperCase();

  if (rfc.length === 12) {
    return {
      rfc,
      type: 'M',
      name: '',
      paternalSurname: '',
      maternalSurname: '',
      businessName: nombre,
      email,
      zipCode,
      regimenFiscal,
      useCfdi,
    };
  }

  const parts = nombreRaw.split(' ').filter(Boolean);
  let name = '';
  let paternalSurname = '';
  let maternalSurname = '';
  if (parts.length >= 3) {
    maternalSurname = parts.pop();
    paternalSurname = parts.pop();
    name = parts.join(' ');
  } else if (parts.length === 2) {
    name = parts[0];
    paternalSurname = parts[1];
  } else if (parts.length === 1) {
    name = parts[0];
  }

  return {
    rfc,
    type: 'F',
    name: name.toUpperCase(),
    paternalSurname: paternalSurname.toUpperCase(),
    maternalSurname: maternalSurname.toUpperCase(),
    businessName: nombre,
    email,
    zipCode,
    regimenFiscal,
    useCfdi,
  };
}

async function _post(path, body, contentType = 'json') {
  const headers = contentType === 'text' ? HEADERS_TEXT : HEADERS_JSON;
  try {
    const res = await axios.post(`${BASE}${path}`, body, { headers, timeout: TIMEOUT_MS });
    return { ok: true, status: res.status, data: res.data };
  } catch (err) {
    return {
      ok: false,
      status: err.response?.status,
      data: err.response?.data,
      error: err.message,
    };
  }
}

async function _get(path) {
  try {
    const res = await axios.get(`${BASE}${path}`, { headers: HEADERS_JSON, timeout: TIMEOUT_MS });
    return { ok: true, status: res.status, data: res.data };
  } catch (err) {
    return { ok: false, status: err.response?.status, error: err.message };
  }
}

/**
 * @param {Object} args
 * @param {Object} args.ticket   { itu, amount }
 * @param {Object} args.usuario  — ver buildUsuario()
 * @param {string} [args.emailPersonal] — solo para texto al usuario (no se envía al portal)
 * @returns {Promise<Object>}
 */
async function facturar({ ticket, usuario, emailPersonal }) {
  const missing = [];
  if (!ticket?.itu) missing.push('ticket.itu');
  if (!ticket?.amount && ticket?.amount !== 0) missing.push('ticket.amount');
  if (!usuario?.rfc) missing.push('usuario.rfc');
  if (!usuario?.email) missing.push('usuario.email');
  if (!usuario?.zipCode) missing.push('usuario.zipCode');
  if (!usuario?.regimenFiscal) missing.push('usuario.regimenFiscal');
  if (!usuario?.businessName) missing.push('usuario.businessName');
  if (missing.length) {
    return { ok: false, error: `Faltan campos: ${missing.join(', ')}`, step: 'input' };
  }

  const itu = normalizeItu(ticket.itu);
  log(`start itu=${itu} rfc=${usuario.rfc} amount=${ticket.amount}`);

  if (itu.length !== 30) {
    return {
      ok: false,
      error: `ITU tiene ${itu.length} caracteres, se esperan 30. Revisa el ticket.`,
      step: 'normalize',
    };
  }

  const maint = await _get('/configuration/getParamMaintenance');
  if (!maint.ok) {
    logErr('step 1 unreachable:', maint.error);
    return { ok: false, error: 'Portal Office Depot no disponible.', step: 'maintenance' };
  }
  if (maint.data?.configValue === '1') {
    return {
      ok: false,
      error: 'Portal Office Depot en mantenimiento. Intenta más tarde.',
      step: 'maintenance',
    };
  }

  const validate = await _post('/invorch/invoicingOrch/validateItu', {
    billingId: 0,
    auxBillingId: 0,
    itu,
    amount: Number(ticket.amount) || 0,
    listItus: [],
    xstore: '',
    series: [],
    totalItus: 0,
    typeOrder: '1',
    company: 'OD',
  });
  if (!validate.ok || !validate.data?.status) {
    const portalMsg = validate.data?.msg || validate.error || 'rechazado';
    logErr('step 2 validateItu:', portalMsg);
    return {
      ok: false,
      error:
        'Office Depot no aceptó este ticket. Puede estar ya facturado, ' +
        'fuera del mes de compra, o el ITU/monto no coinciden.',
      portalMsg,
      step: 'validateItu',
    };
  }
  const { billingId, xstore, origen } = validate.data.object;
  log(`step 2 OK billingId=${billingId} xstore=${xstore} origen=${origen}`);

  await _post('/invorch/invoicingOrch/getRfcStatus', { rfc: usuario.rfc });
  await _post('/invorch/invoicingOrch/getClientData', { rfc: usuario.rfc });

  await _post('/catalogs/catalogs/getStateList', usuario.zipCode, 'text');
  await _post('/catalogs/catalogs/getMunicipalityList', usuario.zipCode, 'text');
  await _post('/catalogs/catalogs/getSuburbList', usuario.zipCode, 'text');

  const validRfc = await _post('/consult/consult/validRfc', {
    businessName: usuario.businessName,
    postalCode: usuario.zipCode,
    regimenFiscal: usuario.regimenFiscal,
    rfc: usuario.rfc,
  });
  if (!validRfc.ok || !validRfc.data?.status) {
    const portalMsg = validRfc.data?.msg || validRfc.error || 'rechazado';
    logErr('step 8 validRfc:', portalMsg);
    return {
      ok: false,
      error:
        'SAT rechazó tus datos fiscales. Verifica nombre, CP y régimen contra ' +
        'tu Constancia de Situación Fiscal.',
      portalMsg,
      step: 'validRfc',
    };
  }
  log('step 8 OK validRfc');

  const emit = await _post('/invorch/invoicingOrch/emitInvoice', {
    iepsRequired: 'N',
    rfc: usuario.rfc,
    type: usuario.type || 'F',
    name: usuario.name || '',
    paternalSurname: usuario.paternalSurname || '',
    maternalSurname: usuario.maternalSurname || '',
    email: usuario.email,
    street: '',
    outerNumber: '',
    innerNumber: '',
    zipCode: usuario.zipCode,
    colony: '',
    colonyText: '',
    nocolony: '',
    state: '',
    municipality: '',
    useCfdi: usuario.useCfdi || 'G03',
    regimenFiscal: usuario.regimenFiscal,
    nacional: 'S',
    numRegId: '',
    fiscalResidence: '',
    solounico: '',
    idTransaction: billingId,
    paymentMethod: 0,
    idTransactionAux: '0',
    xstore,
    origen,
  });

  if (!emit.ok || !emit.data?.status) {
    const portalMsg = emit.data?.object?.errorMsg || emit.data?.msg || emit.error || 'desconocido';
    logErr('step 9 emitInvoice:', portalMsg);
    return {
      ok: false,
      error: 'Office Depot rechazó la emisión. Intenta más tarde.',
      portalMsg,
      step: 'emitInvoice',
    };
  }

  const newItu = emit.data.object?.newItu;
  const inbox = usuario.email;
  const personal = emailPersonal ? String(emailPersonal).trim() : '';
  log(`step 9 OK newItu=${newItu} portalEmail=${inbox}`);

  let msg =
    `✅ *Factura de Office Depot emitida.*\n\n` +
    `📧 El CFDI llegará a *${inbox}* en unos minutos.\n` +
    (personal && personal.toLowerCase() !== inbox.toLowerCase()
      ? `_También te enviaremos XML y PDF a ${personal} cuando los recibamos._\n`
      : '') +
    `\n_Los archivos aparecerán en este chat en cuanto el correo entre al buzón._`;

  return {
    ok: true,
    portal: 'officedepot',
    newItu,
    entrega: 'email',
    email: inbox,
    message: msg,
  };
}

module.exports = { facturar, normalizeItu, buildUsuario };
