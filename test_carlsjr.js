/**
 * test_carlsjr.js — Diagnóstico standalone Carl's Jr. (Grupo Galería)
 * Plataforma: Origon CDC (carlsjr.cdc.origon.cloud) — 100% HTTP/axios, sin Playwright
 *
 * Uso: node test_carlsjr.js
 *
 * Campos del ticket que necesitas (leer del QR o foto):
 *   - BranchCode   → número de sucursal (string, ej. "15")
 *   - TicketNumber → folio del ticket  (string, ej. "3446175")
 *   - PurchaseDate → fecha de compra   (YYYY-MM-DD)
 *   - PurchaseAmount → total pagado    (number, ej. 139)
 */

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

// ─── CONFIGURACIÓN DE PRUEBA ────────────────────────────────────────────────
const TICKET = {
  BranchCode:     '15',          // sucursal San Pedro en el HAR
  TicketNumber:   '3446175',
  PurchaseDate:   '2026-04-12',  // YYYY-MM-DD  (se convierte a UTC midnight)
  PurchaseAmount: 139,
};

const CLIENTE = {
  TaxId:      'SEGC9001195V8',
  LegalName:  'CARLOS ALBERTO SERNA GAMEZ',
  TradeName:  'CARLOS ALBERTO SERNA GAMEZ',
  UseCFDI:    'G03',
  TaxRegime:  '612',
  Email:      'test@cotas.mx',
  PostalCode: '66220',
};

// ─── CONSTANTES DEL EMISOR ───────────────────────────────────────────────────
const BASE_URL     = 'https://carlsjr.cdc.origon.cloud';
const ISSUER_TAXID = 'JFO901024SX4';   // JUNIOR FOODS — fijo para toda la cadena
const CFDI_VERSION = '4.0';

// ─── HEADERS COMUNES ─────────────────────────────────────────────────────────
const HEADERS = {
  'Content-Type': 'application/json; charset=UTF-8',
  'Origin':       BASE_URL,
  'Referer':      `${BASE_URL}/facturacion`,
  'User-Agent':   'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function log(step, msg, data) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`[PASO ${step}] ${msg}`);
  if (data !== undefined) {
    console.log(JSON.stringify(data, null, 2).slice(0, 800));
  }
}

/**
 * Convierte 'YYYY-MM-DD' → '2026-04-12T06:00:00.000Z'
 * (medianoche CST = UTC-6 → 6AM UTC)
 */
function fechaToUTC(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 6, 0, 0)).toISOString();
}

// ─── PASO 1 — Listar sucursales ───────────────────────────────────────────────
async function getBranchList() {
  log('1', 'GetBranchListByIssuer');
  const { data } = await axios.post(
    `${BASE_URL}/Selfservice/GetBranchListByIssuer`,
    { IssuerTaxId: ISSUER_TAXID, RegionCode: '' },
    { headers: HEADERS }
  );
  const branches = data.model || [];
  log('1', `✅ ${branches.length} sucursales encontradas`, branches.slice(0, 5));
  return branches;
}

// ─── PASO 2 — Validar ticket ──────────────────────────────────────────────────
async function validateTicket() {
  log('2', 'ValidateTicketData', TICKET);
  const { data } = await axios.post(
    `${BASE_URL}/Selfservice/ValidateTicketData`,
    {
      BranchCode:     TICKET.BranchCode,
      TicketNumber:   TICKET.TicketNumber,
      PurchaseDate:   fechaToUTC(TICKET.PurchaseDate),
      PurchaseAmount: TICKET.PurchaseAmount,
    },
    { headers: HEADERS }
  );

  if (data.hasError) {
    const msg = data.errorMessage || '';
    const yaFacturado = msg.toLowerCase().includes('facturado') ||
                        msg.toLowerCase().includes('ya fue') ||
                        msg.toLowerCase().includes('ya exist');

    if (yaFacturado) {
      // El portal devuelve hasError=true pero aún permite re-facturar con mismo/distinto RFC.
      // En producción: si el RFC del request coincide con el del CFDI previo → re-descarga.
      // Si es RFC diferente → emite nuevo CFDI.
      log('2', `⚠️  WARNING — Ticket ya fue facturado anteriormente (${msg})`);
      log('2', '   Continuando de todas formas — el portal permite re-emisión...');
      return data;
    }
    // Error genuino (ticket no existe, monto incorrecto, fecha fuera de rango)
    throw new Error(`ValidateTicket error: ${msg}`);
  }

  const docs = data.model?.documentsFound || {};
  const docKeys = Object.keys(docs);

  if (docKeys.length > 0) {
    const firstDoc = docs[docKeys[0]];
    log('2', `⚠️  Ticket ya tiene CFDI previo — status: ${firstDoc?.status}`, firstDoc);
  } else {
    log('2', '✅ Ticket válido, sin CFDI previo');
  }
  return data;
}

// ─── PASO 3 — Regímenes fiscales válidos para el RFC ─────────────────────────
async function getRegimenes(rfc) {
  log('3', `GetLCOCatalogoRegimenFiscal para RFC ${rfc}`);
  const { data } = await axios.get(
    `${BASE_URL}/Selfservice/GetLCOCatalogoRegimenFiscal`,
    { params: { RFC: rfc }, headers: HEADERS }
  );
  const lista = data.model || [];
  log('3', `✅ ${lista.length} regímenes disponibles`, lista);
  return lista;
}

// ─── PASO 4 — Usos de CFDI válidos para el régimen ───────────────────────────
async function getUsosCFDI(regimenFiscal) {
  log('4', `GetLCOCatalogoUsoCFDI para régimen ${regimenFiscal}`);
  const { data } = await axios.get(
    `${BASE_URL}/Selfservice/GetLCOCatalogoUsoCFDI`,
    { params: { regimenFiscal }, headers: HEADERS }
  );
  const lista = data.model || [];
  log('4', `✅ ${lista.length} usos CFDI disponibles`, lista.slice(0, 5));
  return lista;
}

// ─── PASO 5 — Validar CP ──────────────────────────────────────────────────────
async function validateCP(codigoPostal) {
  log('5', `PostcodeInformation para CP ${codigoPostal}`);
  const { data } = await axios.get(
    `${BASE_URL}/Account/PostcodeInformation`,
    { params: { codigoPostal }, headers: HEADERS }
  );
  log('5', '✅ CP válido', data);
  return data;
}

// ─── PASO 6 — Preview CFDI (GetDetailIssue) ───────────────────────────────────
async function getDetailIssue() {
  log('6', 'GetDetailIssue — preview CFDI');
  const body = buildIssueBody();
  const { data } = await axios.post(
    `${BASE_URL}/Selfservice/GetDetailIssue`,
    body,
    { headers: HEADERS }
  );
  if (data.hasError) throw new Error(`GetDetailIssue error: ${data.errorMessage}`);
  const m = data.model;
  log('6', `✅ Preview OK — Total: $${m.total}, IVA: $${m.iva}, Folio: ${m.folio}`, {
    folio: m.folio,
    total: m.total,
    iva:   m.iva,
    subTotal: m.subTotal,
    cfdiUse: m.cfdiUse,
    paymentForm: m.paymentForm,
  });
  return data;
}

// ─── PASO 7 — Emitir CFDI (TicketIssuance) ────────────────────────────────────
async function ticketIssuance() {
  log('7', 'TicketIssuance — emitiendo CFDI...');
  const body = buildIssueBody();
  const { data } = await axios.post(
    `${BASE_URL}/Selfservice/TicketIssuance`,
    body,
    { headers: HEADERS }
  );
  if (data.hasError) throw new Error(`TicketIssuance error: ${data.errorMessage}`);
  const internalId = data.model?.internalId;
  log('7', `✅ CFDI emitido — internalId: ${internalId}`, data.model);
  return internalId;
}

// ─── PASO 8 — Descargar ZIP (PDF + XML) ──────────────────────────────────────
async function getFile(internalId) {
  log('8', `GetFile — descargando PDF+XML para internalId ${internalId}`);
  const { data } = await axios.post(
    `${BASE_URL}/Selfservice/GetFile`,
    {
      isMassiveDownload: false,
      internalIds: [internalId],
      fileType: [1, 2],      // 1=PDF, 2=XML
      filters: {
        pageNumber: 1,
        pageSize: 10,
        orderBy: 'StampDate',
        orderDir: 'DESC',
        finalstampDate:   '2020-10-10',
        initialstampDate: '2020-10-09',
      },
      itemsCount: 7,
    },
    { headers: HEADERS }
  );

  const b64 = data.fileContents;
  if (!b64) throw new Error('GetFile: no fileContents en respuesta');

  // Guardar ZIP
  const zipBuffer = Buffer.from(b64, 'base64');
  const zipPath   = path.join(__dirname, `carlsjr_${internalId}.zip`);
  fs.writeFileSync(zipPath, zipBuffer);

  // Extraer y guardar PDF + XML
  const AdmZip = require('adm-zip');
  const zip    = new AdmZip(zipBuffer);
  const entries = zip.getEntries();
  const result  = {};

  for (const entry of entries) {
    const fname = entry.entryName;
    const buf   = entry.getData();
    const outPath = path.join(__dirname, fname);
    fs.writeFileSync(outPath, buf);
    log('8', `  💾 Guardado: ${fname} (${buf.length} bytes)`);
    if (fname.endsWith('.pdf')) result.pdfBuffer = buf;
    if (fname.endsWith('.xml')) result.xmlString = buf.toString('utf-8');
  }

  log('8', `✅ ZIP guardado en ${zipPath}`);
  console.log('\n   XML preview:', result.xmlString?.slice(0, 300));
  return result;
}

// ─── HELPER: body compartido para GetDetailIssue y TicketIssuance ────────────
function buildIssueBody() {
  return {
    IssuerTaxId:    ISSUER_TAXID,
    BranchCode:     TICKET.BranchCode,
    TicketNumber:   TICKET.TicketNumber,
    PurchaseDate:   fechaToUTC(TICKET.PurchaseDate),
    PurchaseAmount: TICKET.PurchaseAmount,
    WayToPay:       '',
    VersionCFDI:    CFDI_VERSION,
    CustomerData: {
      TaxId:           CLIENTE.TaxId,
      LegalName:       CLIENTE.LegalName,
      UseCFDI:         CLIENTE.UseCFDI,
      TaxRegime:       CLIENTE.TaxRegime,
      TradeName:       CLIENTE.TradeName,
      Email:           CLIENTE.Email,
      Code:            '',
      PhoneNumber:     '',
      IsSelfRegistered: true,
      Address: {
        CountryId:      123,
        CountryName:    'México',
        State:          '',
        City:           '',
        Town:           '',
        District:       '',
        Street:         '',
        PostalCode:     CLIENTE.PostalCode,
        InternalNumber: '',
        ExternalNumber: '',
        Reference:      '',
      },
    },
  };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('🔍 TEST STANDALONE — Carl\'s Jr. / Grupo Galería');
  console.log('   Plataforma: Origon CDC — 100% HTTP, sin Playwright');
  console.log('   Ticket de prueba:', TICKET);

  try {
    // Instalar adm-zip si no está
    const { execSync } = require('child_process');
    try { require('adm-zip'); } catch {
      console.log('\n⚙️  Instalando adm-zip...');
      execSync('npm install adm-zip', { stdio: 'inherit', cwd: __dirname });
    }

    await getBranchList();
    await validateTicket();
    await getRegimenes(CLIENTE.TaxId);
    await getUsosCFDI(CLIENTE.TaxRegime);
    await validateCP(CLIENTE.PostalCode);
    await getDetailIssue();
    const internalId = await ticketIssuance();
    await getFile(internalId);

    console.log('\n\n✅✅✅ FLUJO COMPLETO — Carl\'s Jr. funciona 100% HTTP/axios ✅✅✅');

  } catch (err) {
    console.error('\n❌ ERROR en flujo:', err.response?.data || err.message);
    process.exit(1);
  }
})();
