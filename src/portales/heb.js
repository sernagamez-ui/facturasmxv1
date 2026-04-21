/**
 * Adaptador HEB — facturacion.heb.com.mx
 * UI automation + page.on('response')
 * Selectores Angular Material: mat-form-field input (no getByPlaceholder)
 */

'use strict';

const { chromium } = require('playwright');

const PORTAL     = 'https://facturacion.heb.com.mx/cli/invoice-create';
const FISCAL_URL = 'https://facturacion.heb.com.mx/cli/customer-tax-data';

async function _generarFacturaHEB(ticketData, userData) {
  const { sucursal, noTicket, fecha, total } = ticketData;
  const { rfc, nombre: razonSocial, cp, regimen: regimenFiscal, email, usoCfdi = 'G03' } = userData;

  if (!sucursal || !noTicket || !fecha || total === undefined) {
    throw new Error('HEB faltan datos del ticket');
  }

  const fechaNorm = normalizarFecha(fecha);
  const [anio, mes, dia] = fechaNorm.split('-');

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    locale: 'es-MX',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  try {
    const page = await context.newPage();
    const captured = {};

    // ── Capturar respuestas del SPA ───────────────────────────────────────────
    page.on('response', async (res) => {
      try {
        const url = res.url();
        if (!url.includes('/cli/api')) return;
        if (url.includes('timbrar') && res.request().method() === 'POST')
          captured.timbrado = await res.json();
        else if (url.includes('consulta_facturas_uuid'))
          captured.uuidData = await res.json();
        else if (url.includes('consulta_factura') && !url.includes('uuid'))
          captured.docData = await res.json();
      } catch {}
    });

    // ── 1. Cargar portal ──────────────────────────────────────────────────────
    console.log('[HEB] Cargando portal...');
    await page.goto(PORTAL, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    const storesRes = await page.waitForResponse(
      r => r.url().includes('int_store_sel'), { timeout: 20_000 }
    );
    const storesData = await storesRes.json().catch(() => null);
    console.log('[HEB] Sucursales:', storesData?.rows?.length);

    if (!storesData?.rows?.length) throw new Error('HEB sin sucursales en el portal');

    // ── 2. Resolver sucursal ──────────────────────────────────────────────────
    const storeId = buscarSucursal(storesData.rows, sucursal);
    if (!storeId) throw new Error(`HEB sucursal no encontrada: ${sucursal}`);
    const storeDes = storesData.rows.find(r => r.storE_ID === storeId)?.storE_DES?.trim() ?? sucursal;
    console.log(`[HEB] ${sucursal} → ${storeId} (${storeDes})`);

    // Screenshot del estado inicial del formulario
    await page.screenshot({ path: '/tmp/heb_step0.png' });

    // ── 3. Sucursal autocomplete ──────────────────────────────────────────────
    const inputs = page.locator('mat-form-field input');
    const sucursalInput = inputs.first();

    await sucursalInput.click({ timeout: 8_000 });
    // Buscar por storeId numérico — garantiza match exacto sin ambigüedad
    const query = String(storeId);
    console.log('[HEB] Query autocomplete:', query);
    await sucursalInput.fill(query);
    await page.waitForTimeout(1_500);

    // Seleccionar la opción que contenga el storeId en su texto "(2975) HEB MTY SAN PEDRO"
    const allOpts = page.locator('mat-option');
    const n = await allOpts.count();
    let clicked = false;
    for (let i = 0; i < n; i++) {
      const txt = await allOpts.nth(i).textContent() ?? '';
      if (txt.includes(String(storeId))) {
        await allOpts.nth(i).click();
        clicked = true;
        break;
      }
    }
    if (!clicked && n > 0) await allOpts.first().click();

    console.log('[HEB] Sucursal seleccionada');
    await page.screenshot({ path: '/tmp/heb_step1.png' });

    // ── 4. Ticket ─────────────────────────────────────────────────────────────
    // Segundo mat-form-field input es el campo Ticket
    const ticketInput = inputs.nth(1);
    await ticketInput.click();
    await ticketInput.fill(String(Number(noTicket)));
    console.log('[HEB] Ticket:', Number(noTicket));

    // ── 5. Fecha ──────────────────────────────────────────────────────────────
    // Angular Material date picker no acepta fill() directo de Playwright.
    // Solución: setear el valor vía evaluate + disparar eventos que Angular escucha.
    const MESES = ['enero','febrero','marzo','abril','mayo','junio',
                   'julio','agosto','septiembre','octubre','noviembre','diciembre'];
    const fechaVal = `${parseInt(mes)}/${parseInt(dia)}/${anio}`; // "4/11/2026"
    await page.evaluate((val) => {
      const input = document.querySelectorAll('mat-form-field input')[2];
      input.focus();
      input.value = val;
      input.dispatchEvent(new Event('input',  { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, fechaVal);
    await page.waitForTimeout(400);
    // Si el calendario se abrió, cerrarlo
    const ariaFecha = `${parseInt(dia)} de ${MESES[parseInt(mes,10)-1]} de ${anio}`;
    const diaBtn = page.locator(`[aria-label="${ariaFecha}"]`);
    if (await diaBtn.count() > 0) await diaBtn.first().click();
    else await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    console.log('[HEB] Fecha:', fechaVal);

    // ── 6. Venta ──────────────────────────────────────────────────────────────
    const nInputs = await inputs.count();
    console.log('[HEB] Inputs en formulario:', nInputs);
    // Venta es inputs.nth(3) — usar fill() sin click (spinner bloquea el click)
    await inputs.nth(3).fill(String(total));
    console.log('[HEB] Venta:', total);

    await page.screenshot({ path: '/tmp/heb_step2.png' });

    // ── 7. Agregar ticket ─────────────────────────────────────────────────────
    await page.getByRole('button', { name: /agregar/i }).click();
    console.log('[HEB] Click Agregar ticket');

    const ticketSelRes = await page.waitForResponse(
      r => r.url().includes('int_ticket_sel'), { timeout: 15_000 }
    );
    const ticketSel = await ticketSelRes.json().catch(() => null);
    await page.screenshot({ path: '/tmp/heb_step3.png' });

    if (!ticketSel?.result?.success || !ticketSel?.tickets?.length) {
      const msg = ticketSel?.result?.result_message_user ?? 'ticket no encontrado';
      throw new Error(`HEB ticket no encontrado: ${msg}`);
    }
    console.log('[HEB] Ticket OK');

    // ── 8. Navegar a datos fiscales ───────────────────────────────────────────
    await page.waitForTimeout(1_000);
    await page.getByRole('button', { name: /continuar/i }).click();
    await page.waitForURL('**/customer-tax-data**', { timeout: 10_000 });
    console.log('[HEB] Datos fiscales URL:', page.url());

    // ── 9. Datos fiscales ─────────────────────────────────────────────────────
    // Confirmado por DevTools: 6 inputs tipo text/email, NO hay mat-select
    // Orden: 0=RFC, 1=Nombre/Razón social, 2=CP, 3=Régimen fiscal, 4=Correo, 5=USO CFDI
    const fi = page.locator('mat-form-field input');

    await fi.nth(0).fill(rfc.toUpperCase());
    console.log('[HEB] RFC:', rfc.toUpperCase());

    await fi.nth(1).fill(razonSocial.toUpperCase());
    console.log('[HEB] Nombre:', razonSocial.toUpperCase());

    await fi.nth(2).fill(String(cp));
    await page.waitForTimeout(800); // esperar validación CP
    console.log('[HEB] CP:', cp);

    // Régimen fiscal — es un autocomplete de texto, no mat-select
    await fi.nth(3).fill(String(regimenFiscal));
    await page.waitForTimeout(400);
    // Seleccionar primera opción del dropdown si aparece
    const regimenOpt = page.locator('mat-option').first();
    if (await regimenOpt.count()) await regimenOpt.click();
    console.log('[HEB] Régimen:', regimenFiscal);

    // Correo
    await fi.nth(4).fill(email);
    console.log('[HEB] Email:', email);

    // USO CFDI — autocomplete de texto
    await fi.nth(5).fill(usoCfdi);
    await page.waitForTimeout(400);
    const usoOpt = page.locator('mat-option').first();
    if (await usoOpt.count()) await usoOpt.click();
    console.log('[HEB] Uso CFDI:', usoCfdi);

    await page.waitForTimeout(300);
    await page.screenshot({ path: '/tmp/heb_step5.png' });
    console.log('[HEB] Datos fiscales OK');

    // ── 10. Generar factura ───────────────────────────────────────────────────
    // Registrar el wait ANTES del click — evita race condition donde la respuesta
    // llega antes de que empecemos a escuchar
    const consultaFacturaPromise = page.waitForResponse(
      r => r.url().includes('consulta_factura') && !r.url().includes('uuid'),
      { timeout: 30_000 }
    ).catch(() => null);

    await page.getByRole('button', { name: /generar factura/i }).click();
    console.log('[HEB] Click Generar factura');

    const timbradoRes = await page.waitForResponse(
      r => r.url().includes('timbrar') && r.request().method() === 'POST',
      { timeout: 30_000 }
    );
    captured.timbrado = await timbradoRes.json().catch(() => null);
    await page.screenshot({ path: '/tmp/heb_step6.png' });

    if (!captured.timbrado?.result?.success) {
      throw new Error(`HEB timbrado fallo: ${captured.timbrado?.result?.result_message_user ?? 'error desconocido'}`);
    }
    const facturaInfo = captured.timbrado.list_facturas?.[0];
    if (!facturaInfo?.comp_id) throw new Error('HEB timbrado sin comp_id');
    console.log('[HEB] Timbrado OK comp_id:', facturaInfo.comp_id);

    // ── 11. Capturar XML y PDF ────────────────────────────────────────────────
    await page.waitForTimeout(2_000);
    const docRes = await consultaFacturaPromise;
    if (docRes) captured.docData = await docRes.json().catch(() => null);
    await page.screenshot({ path: '/tmp/heb_step7.png' });
    console.log('[HEB] docData:', !!captured.docData?.list_facturas?.length);

    const doc = captured.docData?.list_facturas?.[0]?.document;
    if (!doc?.xml) throw new Error('HEB sin XML en respuesta');
    if (!doc?.pdf) throw new Error('HEB sin PDF en respuesta');

    return {
      xml:   bufferFromPortalPayload(doc.xml, 'xml'),
      pdf:   bufferFromPortalPayload(doc.pdf, 'pdf'),
      uuid:  facturaInfo.uuid ?? captured.uuidData?.facturas?.[0]?.uuid,
      folio: String(facturaInfo.document?.folio ?? ''),
      serie: facturaInfo.document?.serie ?? '',
    };

  } finally {
    await browser.close();
  }
}

// Wrapper público — sanitiza el mensaje de error para Telegram antes de propagar
async function generarFacturaHEB(ticketData, userData) {
  try {
    return await _generarFacturaHEB(ticketData, userData);
  } catch (err) {
    // Quitar caracteres Markdown de Telegram: * _ ` [ ] ( )
    const msg = String(err.message ?? err)
      .replace(/[*_`[\]()]/g, ' ')
      .split('\n')[0]          // solo primera línea — evita stack traces largos
      .substring(0, 300);
    throw new Error(msg);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * El portal puede devolver XML/PDF en base64 o (en algunos casos) XML como texto.
 */
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
  const palabras = h.split(' ').filter(w => w.length > 3);
  let best = 0, bestId = null;
  for (const r of rows) {
    const cat = norm(r.storE_DES).split(' ').filter(w => w.length > 3);
    const cnt = palabras.filter(w => cat.includes(w)).length;
    if (cnt > best) { best = cnt; bestId = r.storE_ID; }
  }
  return best >= 1 ? bestId : null;
}

function norm(s) {
  return String(s).toLowerCase().trim().replace(/\s+/g, ' ')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

module.exports = { generarFacturaHEB };
