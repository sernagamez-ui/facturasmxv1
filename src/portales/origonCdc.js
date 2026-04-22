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

function soloDigitos(s) {
  return String(s || '').replace(/\D/g, '');
}

function normalizarMonto(n) {
  const x = Number(n);
  if (Number.isNaN(x) || x < 0) return null;
  return Math.round(x * 100) / 100;
}

function normalizarTextoSuc(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Coincide "San Pedro" / nombre de ticket con el catálogo de sucursales del portal. */
function resolverCodePorNombreSucursal(hint, branches) {
  if (!hint || !Array.isArray(branches) || !branches.length) return null;
  const stop = new Set([
    "carl's", "carls", "jr", "rest", "restaurante", "restaurant", "ihop", "bww", "buffalo", "wings", "cjs", "galeria", "galería",
  ]);
  const h = normalizarTextoSuc(hint);
  const palabras = h.split(' ').filter((w) => w.length > 1 && !stop.has(w));
  for (const b of branches) {
    if (b && b.active === false) continue;
    const n = normalizarTextoSuc(b.name || '');
    for (const p of palabras) {
      if (p.length >= 3 && n.includes(p)) return String(b.code);
    }
  }
  for (const b of branches) {
    if (b && b.active === false) continue;
    const n = normalizarTextoSuc(b.name || '');
    if (h && n && (h.includes(n) || n.includes(h))) return String(b.code);
  }
  return null;
}

function codesDeSucursalCandidatos(rawBranch, sucursalNombre, branches) {
  const out = [];
  const seen = new Set();
  const push = (c) => {
    const s = c == null ? '' : String(c).trim();
    if (!s || seen.has(s)) return;
    if (!branches.some((b) => String(b.code) === s)) return;
    seen.add(s);
    out.push(s);
  };

  const soloB = soloDigitos(rawBranch);
  // 1–3 dígitos: típico código tienda. ≥5 a menudo es folio mal colocado.
  if (soloB && soloB.length >= 1 && soloB.length <= 3) push(soloB);

  const n1 = resolverCodePorNombreSucursal(sucursalNombre, branches);
  if (n1) push(n1);
  if (sucursalNombre) {
    const h = normalizarTextoSuc(sucursalNombre);
    for (const b of branches) {
      if (b && b.active === false) continue;
      const nn = normalizarTextoSuc(b.name || '');
      if (h && nn && (h.includes(nn) || nn.includes(h)) && b.code != null) push(String(b.code));
    }
  }
  return out;
}

async function getBranchList(baseUrl, headers, issuerTaxId) {
  const { data } = await axios.post(
    `${baseUrl}/Selfservice/GetBranchListByIssuer`,
    { IssuerTaxId: issuerTaxId, RegionCode: '' },
    origonHttp({ headers, timeout: 60000 })
  );
  if (data?.hasError) throw new Error(data.errorMessage || 'GetBranchListByIssuer');
  return data.model || [];
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
 * @param {string} p.branchCode — código de sucursal (ej. "15"); puede ir vacío si hay sucursalNombre
 * @param {string} [p.sucursalNombre] — nombre de tienda en el ticket, ej. "San Pedro" (se cruza con catálogo del portal)
 * @param {string} p.noTicket — folio del ticket
 * @param {string} p.fecha — YYYY-MM-DD
 * @param {number} p.total — monto total
 * @param {object} p.userData — rfc, nombre, cp, regimen, email, usoCfdi?
 * @param {string} p.outputDir
 */
async function facturarOrigonCdc({
  comercio,
  branchCode,
  sucursalNombre,
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
    const branches = await getBranchList(baseUrl, headers, issuerTaxId);
    const ticketNum = soloDigitos(noTicket);
    if (!ticketNum) {
      return { ok: false, error: 'ticket_invalido', mensaje: 'Folio de ticket vacío o ilegible (se necesitan dígitos del TICKET#).' };
    }
    const monto = normalizarMonto(total);
    if (monto == null) {
      return { ok: false, error: 'ticket_invalido', mensaje: 'Total de ticket no válido.' };
    }
    const purchaseDate = fechaToOrigonUTC(fecha);
    const candidates = codesDeSucursalCandidatos(branchCode, sucursalNombre, branches);
    if (candidates.length === 0) {
      return {
        ok: false,
        error: 'sucursal_desconocida',
        mensaje:
          'No se pudo mapear la sucursal. En el ticket debe verse el *número* de sucursal (en "Datos para facturar") o un nombre de tienda claro (ej. San Pedro) junto con el FOLIO y el TOTAL con IVA.',
      };
    }

    let branchUsado = null;
    let vd = null;
    let lastMsg = '';
    for (const bc of candidates) {
      const ticketPayload = {
        BranchCode: bc,
        TicketNumber: ticketNum,
        PurchaseDate: purchaseDate,
        PurchaseAmount: monto,
      };
      const valRes = await axios.post(
        `${baseUrl}/Selfservice/ValidateTicketData`,
        ticketPayload,
        origonHttp({ headers, timeout: 45000 })
      );
      vd = valRes.data;
      lastMsg = String(vd?.errorMessage || '');
      console.log(
        `[OrigonCDC/${comercio}] ValidateTicketData BranchCode=${bc} TicketNumber=${ticketNum} ` +
        `monto=${monto} hasError=${vd?.hasError} msg=${lastMsg.slice(0, 200)}`
      );
      if (!vd?.hasError || esMensajeYaFacturado(vd.errorMessage)) {
        branchUsado = bc;
        break;
      }
    }
    if (!branchUsado) {
      return {
        ok: false,
        error: 'ticket_invalido',
        mensaje: lastMsg || 'El portal no validó la combinación sucursal / folio / fecha / monto.',
      };
    }

    const ticketPayload = {
      BranchCode: branchUsado,
      TicketNumber: ticketNum,
      PurchaseDate: purchaseDate,
      PurchaseAmount: monto,
    };

    const issueBase = {
      IssuerTaxId: issuerTaxId,
      ...ticketPayload,
      WayToPay: '',
      VersionCFDI: CFDI_VERSION,
      CustomerData: buildCustomerData(userData),
    };

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
