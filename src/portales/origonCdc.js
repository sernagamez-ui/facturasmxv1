// src/portales/origonCdc.js
// Grupo Galería — plataforma Origon CDC (facturación JSON, sin Playwright)
// Flujo confirmado con HAR: GetSelfserviceSetup → ValidateTicketData → GetDetailIssue → TicketIssuance → GetFile
// Cada marca tiene su subdominio *.cdc.origon.cloud; el RFC emisor sale de GetSelfserviceSetup (issuerTaxId).

'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const { getProxyAgent } = require('../proxyAgent');

/** @type {Record<string, { baseUrl: string, label: string }>} */
const ORIGON_CDC_CONFIG = {
  carlsjr: {
    baseUrl: 'https://carlsjr.cdc.origon.cloud',
    label: "Carl's Jr.",
  },
  ihop: {
    baseUrl: 'https://ihop.cdc.origon.cloud',
    label: 'IHOP',
  },
  bww: {
    baseUrl: 'https://bww.cdc.origon.cloud',
    label: 'Buffalo Wild Wings',
  },
};

const ORIGON_CDC_BRANDS = new Set(Object.keys(ORIGON_CDC_CONFIG));

const CFDI_VERSION = '4.0';

function origonHttp(extra = {}) {
  const agent = getProxyAgent('rotating');
  if (!agent) return extra;
  return {
    ...extra,
    httpsAgent: agent,
    httpAgent: agent,
    proxy: false,
  };
}

function buildHeaders(baseUrl) {
  return {
    'Content-Type': 'application/json; charset=UTF-8',
    Origin: baseUrl,
    Referer: `${baseUrl}/facturacion`,
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
  };
}

/** YYYY-MM-DD → medianoche centro → ISO UTC (igual que el portal en el HAR). */
function fechaToOrigonUTC(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  if (!y || !m || !d) throw new Error('fecha inválida (use YYYY-MM-DD)');
  return new Date(Date.UTC(y, m - 1, d, 6, 0, 0)).toISOString();
}

function esMensajeYaFacturado(msg) {
  const s = String(msg || '').toLowerCase();
  return s.includes('facturado') || s.includes('ya fue') || s.includes('ya exist');
}

function mapHttpError(err) {
  const status = err.response?.status;
  if (status === 407) {
    return {
      ok: false,
      error: 'proxy_auth',
      mensaje: 'Proxy HTTP 407 — revisa PROXY_URL_ROTATING.',
    };
  }
  if (status === 401 || status === 403 || status === 429) {
    return {
      ok: false,
      error: 'portal_forbidden',
      mensaje:
        'El portal Origon rechazó la conexión (403/401). Desde datacenters a veces hace falta proxy residencial MX (mismo criterio que 7-Eleven / Petro 7).',
    };
  }
  return null;
}

function extraerUuidXml(xml) {
  const m = String(xml || '').match(/UUID="([0-9A-Fa-f-]{36})"/);
  return m ? m[1].toUpperCase() : null;
}

async function getIssuerTaxId(baseUrl) {
  const { data } = await axios.get(
    `${baseUrl}/Selfservice/GetSelfserviceSetup`,
    origonHttp({ headers: buildHeaders(baseUrl), timeout: 45000 })
  );
  if (data?.hasError) throw new Error(data.errorMessage || 'GetSelfserviceSetup');
  const id = data?.model?.issuerTaxId;
  if (!id) throw new Error('GetSelfserviceSetup: sin issuerTaxId');
  return id;
}

function buildCustomerData(userData) {
  const rfc = String(userData.rfc || '')
    .trim()
    .toUpperCase();
  const nombre = String(userData.nombre || '')
    .trim()
    .toUpperCase();
  const uso =
    userData.usoCfdi || userData.usoCFDI || (String(userData.regimen) === '605' ? 'S01' : 'G03');
  return {
    TaxId: rfc,
    LegalName: nombre,
    TradeName: nombre,
    UseCFDI: uso,
    TaxRegime: String(userData.regimen),
    Email: String(userData.email || '').trim(),
    Code: '',
    PhoneNumber: '',
    IsSelfRegistered: true,
    Address: {
      CountryId: 123,
      CountryName: 'México',
      State: '',
      City: '',
      Town: '',
      District: '',
      Street: '',
      PostalCode: String(userData.cp || '').replace(/\D/g, '').slice(0, 5),
      InternalNumber: '',
      ExternalNumber: '',
      Reference: '',
    },
  };
}

/**
 * @param {object} p
 * @param {string} p.comercio — carlsjr | ihop | bww
 * @param {string} p.branchCode — código de sucursal (ej. "15")
 * @param {string} p.noTicket — folio del ticket
 * @param {string} p.fecha — YYYY-MM-DD
 * @param {number} p.total — monto total
 * @param {object} p.userData — rfc, nombre, cp, regimen, email, usoCfdi?
 * @param {string} p.outputDir
 */
async function facturarOrigonCdc({
  comercio,
  branchCode,
  noTicket,
  fecha,
  total,
  userData,
  outputDir,
}) {
  const cfg = ORIGON_CDC_CONFIG[comercio];
  if (!cfg) {
    return { ok: false, error: 'marca_no_configurada', mensaje: `Marca Origon CDC no soportada: ${comercio}` };
  }

  const baseUrl = cfg.baseUrl;
  const headers = buildHeaders(baseUrl);

  if (getProxyAgent('rotating')) {
    console.log(`[OrigonCDC/${comercio}] peticiones vía PROXY_URL_ROTATING`);
  }

  try {
    const issuerTaxId = await getIssuerTaxId(baseUrl);

    const ticketPayload = {
      BranchCode: String(branchCode).trim(),
      TicketNumber: String(noTicket).trim(),
      PurchaseDate: fechaToOrigonUTC(fecha),
      PurchaseAmount: Number(total),
    };

    const issueBase = {
      IssuerTaxId: issuerTaxId,
      ...ticketPayload,
      WayToPay: '',
      VersionCFDI: CFDI_VERSION,
      CustomerData: buildCustomerData(userData),
    };

    const valRes = await axios.post(
      `${baseUrl}/Selfservice/ValidateTicketData`,
      ticketPayload,
      origonHttp({ headers, timeout: 45000 })
    );
    const vd = valRes.data;
    if (vd?.hasError && !esMensajeYaFacturado(vd.errorMessage)) {
      const msg = vd.errorMessage || 'Ticket no válido';
      return {
        ok: false,
        error: 'ticket_invalido',
        mensaje: msg,
      };
    }

    const preview = await axios.post(
      `${baseUrl}/Selfservice/GetDetailIssue`,
      issueBase,
      origonHttp({ headers, timeout: 45000 })
    );
    if (preview.data?.hasError) {
      return {
        ok: false,
        error: 'preview_error',
        mensaje: preview.data.errorMessage || 'Error en vista previa CFDI',
      };
    }

    const issRes = await axios.post(
      `${baseUrl}/Selfservice/TicketIssuance`,
      issueBase,
      origonHttp({ headers, timeout: 60000 })
    );
    const idm = issRes.data;
    if (idm?.hasError) {
      return {
        ok: false,
        error: 'emision_error',
        mensaje: idm.errorMessage || 'Error al timbrar',
      };
    }

    const internalId = idm?.model?.internalId;
    if (internalId == null) {
      return { ok: false, error: 'sin_internal_id', mensaje: 'Respuesta sin internalId' };
    }

    const fileRes = await axios.post(
      `${baseUrl}/Selfservice/GetFile`,
      {
        isMassiveDownload: false,
        internalIds: [internalId],
        fileType: [1, 2],
        filters: {
          pageNumber: 1,
          pageSize: 10,
          orderBy: 'StampDate',
          orderDir: 'DESC',
          finalstampDate: '2020-10-10',
          initialstampDate: '2020-10-09',
        },
        itemsCount: 7,
      },
      origonHttp({ headers, timeout: 120000 })
    );

    const b64 = fileRes.data?.fileContents;
    if (!b64) {
      return { ok: false, error: 'descarga_vacia', mensaje: 'GetFile no devolvió archivos' };
    }

    fs.mkdirSync(outputDir, { recursive: true });
    const zipBuf = Buffer.from(b64, 'base64');
    const zipPath = path.join(outputDir, `origoncdc_${comercio}_${internalId}.zip`);
    fs.writeFileSync(zipPath, zipBuf);

    const zip = new AdmZip(zipBuf);
    let pdfPath = null;
    let xmlPath = null;
    let xmlString = null;

    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      const name = entry.entryName;
      const buf = entry.getData();
      const safe = name.replace(/[^\w.\-]/g, '_');
      const out = path.join(outputDir, `${comercio}_${internalId}_${safe}`);
      fs.writeFileSync(out, buf);
      if (name.toLowerCase().endsWith('.pdf')) pdfPath = out;
      if (name.toLowerCase().endsWith('.xml')) {
        xmlPath = out;
        xmlString = buf.toString('utf-8');
      }
    }

    const uuid = xmlString ? extraerUuidXml(xmlString) : null;

    return {
      ok: true,
      pdfPath,
      xmlPath,
      uuid,
      zipPath,
      internalId,
      envioPorCorreo: !pdfPath && !xmlPath,
    };
  } catch (err) {
    const mapped = mapHttpError(err);
    if (mapped) return mapped;
    const msg = err.response?.data?.errorMessage || err.response?.data?.message || err.message;
    return {
      ok: false,
      error: 'origon_error',
      mensaje: String(msg),
    };
  }
}

module.exports = {
  facturarOrigonCdc,
  ORIGON_CDC_CONFIG,
  ORIGON_CDC_BRANDS,
  fechaToOrigonUTC,
};
