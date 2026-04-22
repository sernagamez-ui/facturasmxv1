/**
 * Adaptador HEB — facturacion.heb.com.mx
 * Basado en el flujo que timbraba con: waitForResponse(timbrar) + consulta_factura (ver heb.js original).
 * Las promesas se registran ANTES del click para no perder la respuesta (race en datacenters rápidos).
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const HEB_SCREENSHOT_DIR = process.env.HEB_SCREENSHOT_DIR || '/tmp';
function hebScreenshotPath(filename) {
  return path.join(HEB_SCREENSHOT_DIR, filename);
}

const PORTAL = 'https://facturacion.heb.com.mx/cli/invoice-create';

const API_WAIT_MS = 120_000;
const HEB_DEBUG_API = process.env.HEB_DEBUG_API === '1';

/**
 * @param {import('playwright').Page} page
 */
function attachHebApiDebug(page) {
  if (!HEB_DEBUG_API) return;
  const log = (tag, p) => {
    try {
      if (!p.includes('facturacion.heb.com')) return;
      console.log(`[HEB][api] ${tag} ${p.slice(0, 160)}${p.length > 160 ? '…' : ''}`);
    } catch {}
  };
  page.on('request', (req) => log(req.method(), req.url()));
  page.on('response', (res) => {
    if (!res.url().includes('facturacion.heb.com')) return;
    if (res.request().method() === 'GET' && res.status() === 200) return;
    log(String(res.status()), res.url());
  });
}

/**
 * @param {string} u
 * @param {import('playwright').Request} req
 * @param {Record<string, unknown> | null} j
 * @returns {boolean}
 */
function isExcludedHebPreTimbrarUrl(u, req) {
  if (req.method() !== 'POST') return true;
  for (const ex of [
    'int_store_sel',
    'int_ticket_sel',
    'consulta_ticket_forma_pago',
    'consulta_facturas_uuid',
  ]) {
    if (u.includes(ex)) return true;
  }
  // documento (XML/PDF) — no el JSON de timbrado
  if (u.includes('consulta_factura') && !u.includes('consulta_facturas')) return true;
  return false;
}

/**
 * @param {Record<string, unknown> | null} j
 * @param {string} u
 * @returns {boolean}
 */
function looksLikeHebTimbradoJson(j, u) {
  if (!j || typeof j !== 'object' || j.result == null) return false;
  const r = j.result;
  if (typeof r !== 'object' || r === null) return false;
  if (j.list_facturas?.[0]?.document?.xml) return false;
  const ul = u.toLowerCase();
  if (ul.includes('timb') || ul.includes('generar_f') || ul.includes('emision_cfdi')) return true;
  if (j.list_facturas?.[0]?.comp_id) return true;
  if (r.success === false && (ul.includes('timb') || /factur|timb|cfdi|timbr/i.test(String(r.result_message_user ?? '')))) {
    return true;
  }
  return false;
}

/**
 * Resuelve con { json, res } al primer POST a la API cuyo JSON encaje con el timbrado
 * (evita depender de que la ruta contenga todavía la palabra "timbrar").
 * @param {import('playwright').Page} page
 * @param {number} timeoutMs
 */
function waitForHebTimbradoResponse(page, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      page.removeListener('response', onResponse);
      reject(new Error(`HEB timeout: sin timbrado (${timeoutMs / 1000}s). Activa HEB_DEBUG_API=1, revisa heb_step5.png y heb_step6.png. Prueba HEB_HEADFUL=1`));
    }, timeoutMs);

    /** @param {import('playwright').Response} res */
    async function onResponse(res) {
      if (done) return;
      let j = null;
      try {
        const u = res.url();
        if (!u.includes('facturacion.heb.com.mx') || !u.toLowerCase().includes('/api/')) return;
        const req = res.request();
        if (isExcludedHebPreTimbrarUrl(u.toLowerCase(), req)) return;
        const ct = (res.headers()['content-type'] || '').toLowerCase();
        if (!ct.includes('json') || res.status() >= 500) return;
        j = await res.json();
        if (!looksLikeHebTimbradoJson(j, u)) return;
        done = true;
        clearTimeout(t);
        page.removeListener('response', onResponse);
        resolve({ json: j, res });
      } catch {
        // body no-JSON o ya consumido
      }
    }

    page.on('response', onResponse);
  });
}

async function _generarFacturaHEB(ticketData, userData) {
  const { sucursal, noTicket, fecha, total } = ticketData;
  const { rfc, nombre: razonSocial, cp, regimen: regimenFiscal, email, usoCfdi = 'G03' } = userData;

  if (!sucursal || !noTicket || !fecha || total === undefined) {
    throw new Error('HEB faltan datos del ticket');
  }

  const fechaNorm = normalizarFecha(fecha);
  const [anio, mes, dia] = fechaNorm.split('-');

  const headless = process.env.HEB_HEADFUL !== '1';
  const browser = await chromium.launch({ headless, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    locale: 'es-MX',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  try {
    fs.mkdirSync(HEB_SCREENSHOT_DIR, { recursive: true });

    const page = await context.newPage();
    const captured = {};

    attachHebApiDebug(page);

    // Solo lo que no competimos con waitForResponse (evita leer el body del mismo response dos veces)
    page.on('response', async (res) => {
      try {
        const url = res.url();
        if (!url.includes('/cli/api')) return;
        if (url.includes('consulta_facturas_uuid')) {
          captured.uuidData = await res.json();
        }
      } catch {}
    });

    console.log('[HEB] Cargando portal...');
    await page.goto(PORTAL, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    const storesRes = await page.waitForResponse(
      (r) => r.url().includes('int_store_sel'),
      { timeout: 20_000 }
    );
    const storesData = await storesRes.json().catch(() => null);
    console.log('[HEB] Sucursales:', storesData?.rows?.length);
    if (!storesData?.rows?.length) throw new Error('HEB sin sucursales en el portal');

    const storeId = buscarSucursal(storesData.rows, sucursal);
    if (!storeId) throw new Error(`HEB sucursal no encontrada: ${sucursal}`);
    const storeDes = storesData.rows.find((r) => r.storE_ID === storeId)?.storE_DES?.trim() ?? sucursal;
    console.log(`[HEB] ${sucursal} → ${storeId} (${storeDes})`);

    await page.screenshot({ path: hebScreenshotPath('heb_step0.png') });

    const inputs = page.locator('mat-form-field input');
    const sucursalInput = inputs.first();
    await sucursalInput.click({ timeout: 8_000 });
    const query = String(storeId);
    console.log('[HEB] Query autocomplete:', query);
    await sucursalInput.fill(query);
    await page.waitForTimeout(1_500);

    const allOpts = page.locator('mat-option');
    const n = await allOpts.count();
    let clicked = false;
    for (let i = 0; i < n; i++) {
      const txt = (await allOpts.nth(i).textContent()) ?? '';
      if (txt.includes(String(storeId))) {
        await allOpts.nth(i).click();
        clicked = true;
        break;
      }
    }
    if (!clicked && n > 0) await allOpts.first().click();

    console.log('[HEB] Sucursal seleccionada');
    await page.screenshot({ path: hebScreenshotPath('heb_step1.png') });

    const ticketInput = inputs.nth(1);
    await ticketInput.click();
    await ticketInput.fill(String(Number(noTicket)));
    console.log('[HEB] Ticket:', Number(noTicket));

    const MESES = [
      'enero',
      'febrero',
      'marzo',
      'abril',
      'mayo',
      'junio',
      'julio',
      'agosto',
      'septiembre',
      'octubre',
      'noviembre',
      'diciembre',
    ];
    const fechaVal = `${parseInt(mes)}/${parseInt(dia)}/${anio}`;
    await page.evaluate((val) => {
      const input = document.querySelectorAll('mat-form-field input')[2];
      input.focus();
      input.value = val;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, fechaVal);
    await page.waitForTimeout(400);
    const ariaFecha = `${parseInt(dia)} de ${MESES[parseInt(mes, 10) - 1]} de ${anio}`;
    const diaBtn = page.locator(`[aria-label="${ariaFecha}"]`);
    if (await diaBtn.count() > 0) await diaBtn.first().click();
    else await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    console.log('[HEB] Fecha:', fechaVal);

    const nInputs = await inputs.count();
    console.log('[HEB] Inputs en formulario:', nInputs);
    await inputs.nth(3).fill(String(total));
    console.log('[HEB] Venta:', total);

    await page.screenshot({ path: hebScreenshotPath('heb_step2.png') });

    await page.getByRole('button', { name: /agregar/i }).click();
    console.log('[HEB] Click Agregar ticket');

    const ticketSelRes = await page.waitForResponse(
      (r) => r.url().includes('int_ticket_sel'),
      { timeout: 15_000 }
    );
    const ticketSel = await ticketSelRes.json().catch(() => null);
    await page.screenshot({ path: hebScreenshotPath('heb_step3.png') });

    if (!ticketSel?.result?.success || !ticketSel?.tickets?.length) {
      const msg = ticketSel?.result?.result_message_user ?? 'ticket no encontrado';
      throw new Error(`HEB ticket no encontrado: ${msg}`);
    }
    console.log('[HEB] Ticket OK');

    await page.waitForTimeout(1_000);
    await page.getByRole('button', { name: /continuar/i }).click();
    await page.waitForURL('**/customer-tax-data**', { timeout: 10_000 });
    console.log('[HEB] Datos fiscales URL:', page.url());

    const fi = page.locator('mat-form-field input');
    await fi.nth(0).fill(rfc.toUpperCase());
    console.log('[HEB] RFC:', rfc.toUpperCase());
    await fi.nth(1).fill(razonSocial.toUpperCase());
    console.log('[HEB] Nombre:', razonSocial.toUpperCase());
    await fi.nth(2).fill(String(cp));
    await page.waitForTimeout(800);
    console.log('[HEB] CP:', cp);
    await fi.nth(3).fill(String(regimenFiscal));
    await page.waitForTimeout(400);
    const regimenOpt = page.locator('mat-option').first();
    if (await regimenOpt.count()) await regimenOpt.click();
    console.log('[HEB] Régimen:', regimenFiscal);
    await fi.nth(4).fill(email);
    console.log('[HEB] Email:', email);
    await fi.nth(5).fill(usoCfdi);
    await page.waitForTimeout(400);
    const usoOpt = page.locator('mat-option').first();
    if (await usoOpt.count()) await usoOpt.click();
    console.log('[HEB] Uso CFDI:', usoCfdi);

    await page.waitForTimeout(300);
    await page.screenshot({ path: hebScreenshotPath('heb_step5.png') });
    console.log('[HEB] Datos fiscales OK');

    // El SPA a veces llama consulta_ticket_forma_pago al validar RFC/CP; esperamos para no hacer click
    // en un formulario aún inestable (mismo flujo en logs con ticket OK + datos fiscales).
    await page
      .waitForResponse(
        (r) => r.url().includes('consulta_ticket_forma_pago') && r.request().method() === 'POST',
        { timeout: 8_000 }
      )
      .then(() => console.log('[HEB] API consulta_ticket_forma_pago OK'))
      .catch(() => {
        if (HEB_DEBUG_API) {
          console.log('[HEB] consulta_ticket_forma_pago no visto 8s, sigo igual');
        }
      });

    // ── 10. Timbrar: promesas ANTES del click; acepta URLs nuevas o JSON con list_facturas/comp_id ──
    const esConsultaDocumento = (r) => {
      const u = r.url();
      return (
        u.includes('consulta_factura') && !u.includes('uuid') && !u.includes('consulta_facturas_uuid')
      );
    };

    const timbrarPromise = waitForHebTimbradoResponse(page, API_WAIT_MS);
    const consultaFacturaPromise = page
      .waitForResponse(esConsultaDocumento, { timeout: API_WAIT_MS })
      .catch(() => null);

    const btnGen = page.getByRole('button', { name: /generar factura/i });
    await btnGen.waitFor({ state: 'visible', timeout: 15_000 });
    const enabled0 = await btnGen.isEnabled();
    if (!enabled0) {
      await page.waitForTimeout(1_000);
    }
    let enabled = await btnGen.isEnabled();
    for (let i = 0; i < 30 && !enabled; i += 1) {
      await page.waitForTimeout(1_000);
      enabled = await btnGen.isEnabled();
    }
    if (!enabled) {
      await page.screenshot({ path: hebScreenshotPath('heb_step5b_disabled.png') });
      throw new Error('HEB botón Generar factura deshabilitado. Revisa RFC/CP o heb_step5b_disabled.png');
    }
    await btnGen.scrollIntoViewIfNeeded();
    try {
      await btnGen.click({ timeout: 10_000 });
    } catch {
      await btnGen.click({ force: true });
    }
    console.log('[HEB] Click Generar factura');

    const { json: timbradoJson } = await timbrarPromise;
    captured.timbrado = timbradoJson;
    await page.screenshot({ path: hebScreenshotPath('heb_step6.png') });

    if (!captured.timbrado?.result?.success) {
      throw new Error(
        `HEB timbrado fallo: ${captured.timbrado?.result?.result_message_user ?? 'error desconocido'}`
      );
    }
    const facturaInfo = captured.timbrado.list_facturas?.[0];
    if (!facturaInfo?.comp_id) throw new Error('HEB timbrado sin comp_id');
    console.log('[HEB] Timbrado OK comp_id:', facturaInfo.comp_id);

    // ── 11. Documento (XML/PDF) ──
    await page.waitForTimeout(2_000);
    const docRes = await consultaFacturaPromise;
    if (docRes) captured.docData = await docRes.json().catch(() => null);
    await page.screenshot({ path: hebScreenshotPath('heb_step7.png') });
    console.log('[HEB] docData:', !!captured.docData?.list_facturas?.length);

    const doc = captured.docData?.list_facturas?.[0]?.document;
    if (!doc?.xml) throw new Error('HEB sin XML en respuesta');
    if (!doc?.pdf) throw new Error('HEB sin PDF en respuesta');

    return {
      xml: bufferFromPortalPayload(doc.xml, 'xml'),
      pdf: bufferFromPortalPayload(doc.pdf, 'pdf'),
      uuid: facturaInfo.uuid ?? captured.uuidData?.facturas?.[0]?.uuid,
      folio: String(facturaInfo.document?.folio ?? ''),
      serie: facturaInfo.document?.serie ?? '',
    };
  } finally {
    await browser.close();
  }
}

async function generarFacturaHEB(ticketData, userData) {
  try {
    return await _generarFacturaHEB(ticketData, userData);
  } catch (err) {
    const msg = String(err.message ?? err)
      .replace(/[*_`[\]()]/g, ' ')
      .split('\n')[0]
      .substring(0, 300);
    throw new Error(msg);
  }
}

function bufferFromPortalPayload(raw, kind) {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw == null || raw === '') throw new Error(`HEB sin ${kind} en respuesta`);
  const s = String(raw).trim();
  if (kind === 'xml' && (s.startsWith('<?xml') || /^<[a-zA-Z]/.test(s))) {
    return Buffer.from(s, 'utf8');
  }
  const fromB64 = Buffer.from(s, 'base64');
  if (kind === 'pdf') {
    if (fromB64.length >= 4 && fromB64.slice(0, 4).toString('latin1') === '%PDF') return fromB64;
    throw new Error('HEB PDF no decodificable (no es PDF válido)');
  }
  const head = fromB64.slice(0, Math.min(400, fromB64.length)).toString('utf8');
  if (head.includes('<?xml') || head.includes('<cfdi') || head.includes('cfdi:')) return fromB64;
  if (s.startsWith('<')) return Buffer.from(s, 'utf8');
  return fromB64;
}

function normalizarFecha(fecha) {
  const s = String(fecha).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  throw new Error(`HEB fecha no reconocida: ${fecha}`);
}

function buscarSucursal(rows, nombreTicket) {
  const h = norm(nombreTicket);
  for (const r of rows) if (norm(r.storE_DES) === h) return r.storE_ID;
  for (const r of rows) if (norm(r.storE_DES).includes(h)) return r.storE_ID;
  for (const r of rows) {
    const n = norm(r.storE_DES);
    if (n.length > 4 && h.includes(n)) return r.storE_ID;
  }
  const palabras = h.split(' ').filter((w) => w.length > 3);
  let best = 0;
  let bestId = null;
  for (const r of rows) {
    const cat = norm(r.storE_DES)
      .split(' ')
      .filter((w) => w.length > 3);
    const cnt = palabras.filter((w) => cat.includes(w)).length;
    if (cnt > best) {
      best = cnt;
      bestId = r.storE_ID;
    }
  }
  return best >= 1 ? bestId : null;
}

function norm(s) {
  return String(s)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

module.exports = { generarFacturaHEB };
