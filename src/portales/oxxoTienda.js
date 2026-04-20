// src/portales/oxxoTienda.js — Facturación tienda OXXO (conveniencia)
// Portal JSF + PrimeFaces: https://www4.oxxo.com:9443/facturacionElectronica-web/
// Playwright: por defecto sin proxy (puerto 9443 + residencial suele romper el túnel). Ver getPlaywrightProxyOxxoTienda.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { getPlaywrightProxyOxxoTienda } = require('../proxyAgent');

const PORTAL_URL =
  'https://www4.oxxo.com:9443/facturacionElectronica-web/views/layout/inicio.do';

const FOLIO_SEL = '[id="form:folio"], input[name="form:folio"]';

function isRailwayHost() {
  return Boolean(process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_ENVIRONMENT_ID);
}

/** Mensaje corto si el formulario no aparece (IP / WAF). */
function hintOxxoTiendaInfra() {
  if (!isRailwayHost()) return '';
  return (
    ' En servidores como Railway la IP suele ser extranjera y OXXO tienda (:9443) no muestra el formulario. ' +
    'Opciones: correr el bot en tu PC o un VPS en México; o probar OXXO_TIENDA_USE_PLAYWRIGHT_PROXY=1 si tu proxy permite el puerto 9443 (p. ej. SOCKS).'
  );
}

function fechaIsoADmy(fecha) {
  if (!fecha) return null;
  const s = String(fecha).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  const m2 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m2) {
    const d = m2[1].padStart(2, '0');
    const mo = m2[2].padStart(2, '0');
    return `${d}/${mo}/${m2[3]}`;
  }
  return s;
}

function getUsoCfdi(regimen, usoPreferido) {
  if (usoPreferido) return String(usoPreferido).trim();
  return { '605': 'S01', '612': 'G03', '626': 'G03' }[String(regimen)] || 'G03';
}

/**
 * @param {object} params
 * @param {string} params.fecha — YYYY-MM-DD o DD/MM/YYYY
 * @param {string} params.folio — folio numérico de venta
 * @param {string} params.venta — código alfanumérico (ej. 10ZAI50ZRC1)
 * @param {string|number} params.total
 * @param {object} params.userData — rfc, nombre, cp, regimen, email, usoCFDI opcional
 * @param {string} params.outputDir
 */
async function facturarOxxoTienda({ fecha, folio, venta, total, userData, outputDir }) {
  const faltantes = [];
  if (!folio) faltantes.push('folio');
  if (!venta) faltantes.push('venta');
  if (!total && total !== 0) faltantes.push('total');
  if (!fecha) faltantes.push('fecha');
  if (!userData?.rfc || !userData?.cp || !userData?.regimen) {
    return {
      ok: false,
      error: 'Perfil incompleto: se requiere RFC, código postal y régimen fiscal.',
    };
  }
  if (faltantes.length) {
    return { ok: false, error: `Faltan datos del ticket OXXO: ${faltantes.join(', ')}` };
  }

  const fechaDmy = fechaIsoADmy(fecha);
  if (!fechaDmy) {
    return { ok: false, error: 'Fecha del ticket inválida.' };
  }

  const folioStr = String(folio).replace(/\s/g, '');
  const ventaStr = String(venta).replace(/\s/g, '').toUpperCase();
  const totalStr = Number(total).toFixed(2);
  const usoCode = getUsoCfdi(userData.regimen, userData.usoCFDI || userData.usoCfdi);

  const proxy = getPlaywrightProxyOxxoTienda();
  const hayProxyEnEnv =
    String(process.env.PROXY_URL_STICKY || '').trim() ||
    String(process.env.PROXY_URL_ROTATING || '').trim();
  if (!proxy && hayProxyEnEnv && String(process.env.OXXO_TIENDA_USE_PLAYWRIGHT_PROXY || '').trim() !== '1') {
    console.log(
      '[OxxoTienda] Playwright sin proxy (9443 + proxy residencial suele dar ERR_TUNNEL). OXXO_TIENDA_USE_PLAYWRIGHT_PROXY=1 para forzar.'
    );
  }
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    ...(proxy ? { proxy } : {}),
  });

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    console.log('[OxxoTienda] Abriendo portal...');
    const res = await page.goto(PORTAL_URL, { waitUntil: 'load', timeout: 120_000 });
    console.log('[OxxoTienda] HTTP', res?.status(), 'URL:', page.url());
    // JSF/PrimeFaces: dar tiempo al render (networkidle en nube a veces no aplica o tarda distinto)
    await page.waitForTimeout(3000);
    const folioLoc = page.locator(FOLIO_SEL).first();
    await folioLoc.waitFor({ state: 'attached', timeout: 45_000 });
    await folioLoc.waitFor({ state: 'visible', timeout: 90_000 });

    const fechaEl = page.locator('[id="form:fecha_input"]');
    try {
      await fechaEl.fill(fechaDmy);
    } catch {
      await page.evaluate((d) => {
        const el = document.querySelector('[id="form:fecha_input"]');
        if (!el) return;
        el.removeAttribute('readonly');
        el.value = d;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
      }, fechaDmy);
    }
    await folioLoc.fill(folioStr);
    await page.locator('[id="form:venta"]').fill(ventaStr);
    await page.locator('[id="form:total"]').fill(totalStr);

    await page.locator('[id="form:validarTicket"]').click();

    await page.waitForFunction(
      () => {
        const t = document.body.innerText || '';
        return (
          t.includes('El ticket ingresado es válido') ||
          t.includes('ticket ingresado es válido') ||
          t.includes('no tuvo éxito') ||
          t.includes('no tuvo exito')
        );
      },
      { timeout: 45_000 }
    );

    const afterVal = await page.innerText('body');
    if (afterVal.includes('no tuvo éxito') || afterVal.includes('no tuvo exito')) {
      return {
        ok: false,
        error:
          'El portal no validó el ticket (folio, código de venta, fecha o total). Revisa la foto del ticket.',
      };
    }

    await page.locator('[id="form:continuar"]').click();
    await page.locator('[id="form:rfc"]').waitFor({ state: 'visible', timeout: 45_000 });

    const rfc = String(userData.rfc).toUpperCase().trim();
    await page.locator('[id="form:rfc"]').fill(rfc);
    await page.locator('[id="form:rfc"]').blur();
    await page.waitForTimeout(1500);

    const razon = await page.locator('[id="form:razon"]').inputValue().catch(() => '');
    if (!razon?.trim() && userData.nombre) {
      await page.locator('[id="form:razon"]').fill(userData.nombre);
    }

    await page.locator('[id="form:codigo"]').fill(String(userData.cp).replace(/\D/g, '').slice(0, 5));
    await page.locator('[id="form:codigo"]').press('Tab');

    await seleccionarOpcionSelect(page, 'form:selectOneMenuRegFis_input', String(userData.regimen));
    await page.waitForTimeout(800);
    await seleccionarOpcionSelect(page, 'form:selectOneMenuCFDI_input', usoCode);

    await page.locator('[id="form:generarFactura"]').click();
    await page
      .getByRole('button', { name: 'Descargar PDF' })
      .first()
      .waitFor({ state: 'visible', timeout: 90_000 });

    fs.mkdirSync(outputDir, { recursive: true });
    const baseName = `oxxo_${folioStr}`;

    const downloadPdf = page.waitForEvent('download', { timeout: 120_000 });
    await page.getByRole('button', { name: 'Descargar PDF' }).first().click();
    const pdf = await downloadPdf;
    const pdfPath = path.join(outputDir, `${baseName}.pdf`);
    await pdf.saveAs(pdfPath);
    console.log('[OxxoTienda] PDF:', pdfPath);

    const downloadXml = page.waitForEvent('download', { timeout: 120_000 });
    await page.getByRole('button', { name: 'Descargar XML' }).first().click();
    const xml = await downloadXml;
    const xmlPath = path.join(outputDir, `${baseName}.xml`);
    await xml.saveAs(xmlPath);
    console.log('[OxxoTienda] XML:', xmlPath);

    let uuid = null;
    try {
      const xmlStr = fs.readFileSync(xmlPath, 'utf8');
      const um = xmlStr.match(/UUID="([^"]+)"/i) || xmlStr.match(/<tfd:TimbreFiscalDigital[^>]*UUID="([^"]+)"/i);
      if (um) uuid = um[1];
    } catch (_) {}

    return { ok: true, pdfPath, xmlPath, uuid, envioPorCorreo: false };
  } catch (err) {
    console.error('[OxxoTienda] ❌', err.message);
    let preview = '';
    try {
      preview = (await page.innerText('body').catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 500);
      if (preview) console.error('[OxxoTienda] vista previa body:', preview);
    } catch (_) {}
    const suffix = hintOxxoTiendaInfra();
    const errOut =
      preview && (err.message || '').includes('Timeout')
        ? `${err.message} — fragmento página: ${preview.slice(0, 280)}`
        : err.message;
    return { ok: false, error: errOut + suffix };
  } finally {
    await browser.close();
  }
}

/**
 * El portal usa <select> con etiquetas que incluyen clave SAT (régimen / uso CFDI).
 */
async function seleccionarOpcionSelect(page, selectId, claveBuscada) {
  const id = `[id="${selectId}"]`;
  await page.waitForSelector(id, { timeout: 20_000 });
  const ok = await page.evaluate(
    ({ sid, clave }) => {
      const sel = document.querySelector(`[id="${sid}"]`);
      if (!sel || !sel.options) return false;
      const c = String(clave).trim();
      for (let i = 0; i < sel.options.length; i++) {
        const opt = sel.options[i];
        const text = (opt.textContent || '').toUpperCase();
        const val = (opt.value || '').toUpperCase();
        if (text.includes(c) || val === c) {
          sel.selectedIndex = i;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      return false;
    },
    { sid: selectId, clave: claveBuscada }
  );
  if (!ok) {
    throw new Error(`No encontré la opción "${claveBuscada}" en ${selectId}.`);
  }
}

module.exports = { facturarOxxoTienda, fechaIsoADmy };
