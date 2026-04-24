// src/portales/soriana.js
// Facturación Soriana (www.soriana.com) — Playwright + storageState, flujo tipo OXXO Gas.
// Captura HAR: Billing-TipoTicket → ValidacionesRfc → ListaTipoUsoCFDI → PrevisualizarFactura → EmitirFactura

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { resolveDataDir } = require('../dataDir');

const BASE = 'https://www.soriana.com';
const FACTURA_URL = `${BASE}/facturacionelectronica#FacturarCompra`;
const DW = '/on/demandware.store/Sites-Soriana-Site/default';
const DATA_DIR = resolveDataDir();
const SESSION_FILE = path.join(DATA_DIR, 'soriana-session.json');

const GOTO = { waitUntil: 'load', timeout: 120_000 };

function normalizeTicketNo(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  return d || '';
}

function tipoTicketFromTipoApi(data) {
  if (!data || typeof data !== 'object') return null;
  // HAR (compra en tienda): tipoTicket=1.0 cuando esVenta=true. Otros tipos requieren otro código en portal.
  if (data.esVenta) return '1.0';
  return null;
}

function getUsoCfdiDefault(regimen) {
  return { '605': 'S01', '612': 'G03', '626': 'G03' }[String(regimen)] || 'G03';
}

function pickUsoCfdi(userData) {
  const u = userData.usoCfdi || userData.usoCFDI;
  if (u && String(u).trim()) return String(u).trim().toUpperCase();
  return getUsoCfdiDefault(userData.regimen);
}

/**
 * @param {object} params
 * @param {string} params.noTicket — número de ticket (solo dígitos, ej. ticket de tienda Soriana)
 * @param {object} params.userData — rfc, nombre (debe coincidir con SAT), cp, regimen, email
 * @param {string} params.outputDir
 */
async function facturarSoriana({ noTicket, userData, outputDir }) {
  if (!fs.existsSync(SESSION_FILE)) {
    return {
      ok: false,
      error: 'No hay sesión Soriana. Corre: node save-session.js soriana',
    };
  }

  const ticketNorm = normalizeTicketNo(noTicket);
  if (!ticketNorm || ticketNorm.length < 10) {
    return { ok: false, error: 'Número de ticket Soriana inválido o demasiado corto.' };
  }
  if (!userData?.rfc || !userData?.nombre || !userData?.cp || !userData?.regimen || !userData?.email) {
    return {
      ok: false,
      error: 'Perfil incompleto: RFC, nombre/razón social (como en el SAT), CP, régimen y correo.',
    };
  }

  const rfc = String(userData.rfc).replace(/\s/g, '').toUpperCase();
  const nombre = String(userData.nombre).trim();
  const regimen = String(userData.regimen).trim();
  const cp = String(userData.cp).replace(/\s/g, '');
  const email = String(userData.email).trim();
  const usoCfdi = pickUsoCfdi(userData);

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext({ storageState: SESSION_FILE });
    const page = await context.newPage();

    console.log('[Soriana] Abriendo facturación electrónica...');
    await page.goto(FACTURA_URL, GOTO);

    const urlAfter = page.url();
    if (/iniciar-sesion|facturacion-login/i.test(urlAfter)) {
      return {
        ok: false,
        error:
          'Sesión Soriana no válida o expirada (redirige a login). Vuelve a guardar soriana-session.json tras iniciar sesión en el mismo entorno donde corre el bot.',
      };
    }

    const tipoJson = await page.evaluate(async ({ dw, ticket }) => {
      const r = await fetch(`${dw}/Billing-TipoTicket?ticketNo=${encodeURIComponent(ticket)}`, {
        method: 'GET',
        credentials: 'include',
        headers: { 'x-requested-with': 'XMLHttpRequest', accept: 'application/json, text/javascript, */*; q=0.01' },
      });
      const text = await r.text();
      try {
        return JSON.parse(text);
      } catch {
        return { parseError: true, status: r.status, snippet: text.slice(0, 400) };
      }
    }, { dw: DW, ticket: ticketNorm });

    if (tipoJson.parseError) {
      console.warn('[Soriana] Billing-TipoTicket parse:', tipoJson.snippet);
      return { ok: false, error: 'Respuesta inválida al validar ticket (¿sesión caída?).' };
    }

    const tr = tipoJson.result;
    if (!tr?.success) {
      const msg = tr?.message || 'Ticket no encontrado';
      return {
        ok: false,
        error: msg,
        userMessage: `🔍 Soriana: ${msg}. Verifica el número de ticket y que no esté facturado.`,
      };
    }
    if (tr.ticketFacturado) {
      return { ok: false, error: 'Este ticket ya fue facturado en Soriana.' };
    }

    const tipoTicket = tipoTicketFromTipoApi(tr.data);
    if (!tipoTicket) {
      return {
        ok: false,
        error: 'Tipo de ticket no soportado aún (solo compra en tienda / flujos mapeados).',
      };
    }

    const rfcJson = await page.evaluate(async ({ dw, rfc: rfcVal }) => {
      const r = await fetch(`${dw}/Billing-ValidacionesRfc?rfc=${encodeURIComponent(rfcVal)}`, {
        method: 'GET',
        credentials: 'include',
        headers: { 'x-requested-with': 'XMLHttpRequest', accept: 'application/json, text/javascript, */*; q=0.01' },
      });
      return r.json();
    }, { dw: DW, rfc });

    if (!rfcJson.result?.success) {
      return { ok: false, error: rfcJson.result?.message || 'RFC no válido en portal Soriana.' };
    }

    const regimenList = rfcJson.result.data || [];
    const regimenNum = Number(regimen);
    const regimenRow = regimenList.find((row) => Number(row.CLAVE) === regimenNum);
    if (!regimenRow) {
      return {
        ok: false,
        error: `Régimen fiscal ${regimen} no aplica a este RFC en Soriana.`,
      };
    }
    const regimenFiscalText = String(regimenRow.TEXTO || '').trim();

    const usoBody = new URLSearchParams({ regimenFiscal: regimen, rfc }).toString();
    const usoJson = await page.evaluate(async ({ dw, body }) => {
      const r = await fetch(`${dw}/Billing-ListaTipoUsoCFDI`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'x-requested-with': 'XMLHttpRequest',
          accept: 'application/json, text/javascript, */*; q=0.01',
        },
        body,
      });
      return r.json();
    }, { dw: DW, body: usoBody });

    const usoList = usoJson.result?.data || [];
    const usoRow = usoList.find((row) => String(row.Id_Cve_TipoUsoCFDI).toUpperCase() === usoCfdi);
    if (!usoRow) {
      return {
        ok: false,
        error: `Uso CFDI ${usoCfdi} no disponible para régimen ${regimen} en Soriana.`,
      };
    }
    const usoCfdiText = String(usoRow.Desc_TipoUsoCFDI || usoCfdi).trim();

    const previewParams = new URLSearchParams({
      ticketNumber: ticketNorm,
      agregarRfc: rfc,
      nombreRazonSocial: nombre,
      regimenFiscal: regimen,
      usoCfdi,
      folioIeps: '',
      codigoPostal: cp,
      correoElectronico: email,
      tipoTicket,
      subtotal: 'null',
      descuentos: 'null',
      bonificacionTipoPago: 'null',
      iva: 'null',
      ieps: 'null',
      total: 'null',
      regimenFiscalText: `                    ${regimenFiscalText}                    `,
      usoCfdiText,
    });

    const prevJson = await page.evaluate(async ({ dw, qs }) => {
      const r = await fetch(`${dw}/Billing-PrevisualizarFactura?${qs}`, {
        method: 'GET',
        credentials: 'include',
        headers: { 'x-requested-with': 'XMLHttpRequest', accept: 'application/json, text/javascript, */*; q=0.01' },
      });
      return r.json();
    }, { dw: DW, qs: previewParams.toString() });

    if (!prevJson.result?.success || !prevJson.result?.totales) {
      const msg = prevJson.result?.message || JSON.stringify(prevJson.result || {});
      return { ok: false, error: `Previsualización: ${msg}` };
    }

    const t = prevJson.result.totales;
    const emitBody = new URLSearchParams({
      ticketNumber: ticketNorm,
      agregarRfc: rfc,
      nombreRazonSocial: nombre,
      regimenFiscal: regimen,
      usoCfdi,
      folioIeps: '',
      codigoPostal: cp,
      correoElectronico: email,
      tipoTicket,
      subtotal: String(t.subtotal),
      descuentos: String(t.descuentos),
      bonificacionTipoPago: String(t.bonificacionTipoPago),
      iva: String(t.iva),
      ieps: String(t.ieps),
      total: String(t.total),
    }).toString();

    console.log('[Soriana] Emitiendo factura...');
    const emitJson = await page.evaluate(async ({ dw, body }) => {
      const r = await fetch(`${dw}/Billing-EmitirFactura`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'x-requested-with': 'XMLHttpRequest',
          accept: 'application/json, text/javascript, */*; q=0.01',
        },
        body,
      });
      return r.json();
    }, { dw: DW, body: emitBody });

    const er = emitJson.result;
    if (!er?.success) {
      const msg = er?.message || 'Error al timbrar';
      const detalle = er?.data?.[0]?.message || '';
      const full = detalle ? `${msg} ${detalle}` : msg;
      return {
        ok: false,
        error: full,
        userMessage:
          /CFDI40145|nombre.*receptor/i.test(full)
            ? '⚠️ El SAT rechazó el nombre del receptor: en tu perfil debe ir la *razón social o nombre completo exactamente como en la constancia fiscal* (como en el HAR: un apellido de menos causó error).'
            : `⚠️ Soriana: ${full}`,
      };
    }

    const row = er.data && er.data[0];
    const uuid = row?.uuid || null;
    let xmlPath = null;
    let pdfPath = null;

    if (row?.xml64) {
      fs.mkdirSync(outputDir, { recursive: true });
      const folio = row.folio || 'factura';
      xmlPath = path.join(outputDir, `${folio}.xml`);
      fs.writeFileSync(xmlPath, Buffer.from(row.xml64, 'base64'));
      console.log('[Soriana] XML:', xmlPath);
    }
    if (row?.pdf64) {
      fs.mkdirSync(outputDir, { recursive: true });
      const folio = row.folio || 'factura';
      pdfPath = path.join(outputDir, `${folio}.pdf`);
      fs.writeFileSync(pdfPath, Buffer.from(row.pdf64, 'base64'));
      console.log('[Soriana] PDF:', pdfPath);
    }

    return {
      ok: true,
      uuid,
      folio: row?.folio,
      serie: row?.serie,
      xmlPath,
      pdfPath,
      total: t.total,
      message: er.message,
    };
  } catch (err) {
    console.error('[Soriana]', err.message);
    return { ok: false, error: err.message };
  } finally {
    try {
      await browser.close();
    } catch (_) {}
  }
}

module.exports = { facturarSoriana };
