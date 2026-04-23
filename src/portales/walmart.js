/**
 * Walmart México (grupo Walmex: Walmart, Supercenter, Sam's Club, Bodega Aurrera, etc.)
 * Portal: https://facturacion.walmartmexico.com.mx/
 *
 * Flujo (ASP.NET WebForms + UpdatePanel, capturado en HAR 2026-04):
 *   1. frmDatos — RFC, CP, TC# (código de ticket), TR# (transacción) → Info → TR → Aceptar
 *   2. frmRFCEdita — razón social, CP, email, régimen, uso CFDI → Aceptar
 *   3. (opcional) forma de pago — ddlPaymentType + Continuar
 *   4. frmReportAdmin — envío por correo (rdCorreo) → Facturar
 *
 * A diferencia de Home Depot, no hay API REST: automatización vía Playwright.
 * El CFDI se envía al correo (mismo patrón de éxito que HEB con envioPorCorreo).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { getPlaywrightProxy } = require('../proxyAgent');

const BASE = 'https://facturacion.walmartmexico.com.mx/frmDatos.aspx';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const WAIT_MS = 90_000;

const SHOT = process.env.WALMART_SCREENSHOT_DIR || '/tmp';

/**
 * @param {string} s
 * @returns {string}
 */
function onlyDigits(s) {
  return String(s || '').replace(/\D/g, '');
}

/**
 * @param {object} p
 * @param {string} p.tc — TC# (solo dígitos, p. ej. 7433231412118272030604)
 * @param {string} p.tr — TR# (transacción, p. ej. 986 o 1391)
 * @param {object} p.userData — rfc, nombre, cp, regimen, email, usoCfdi|usoCFDI
 * @returns {Promise<{ ok: true, envioPorCorreo: true } | { ok: false, error: string, userMessage: string }>}
 */
async function facturarWalmart({ tc, tr, userData }) {
  const rfc = String(userData.rfc || '')
    .trim()
    .toUpperCase();
  const cp = onlyDigits(userData.codigoPostal || userData.cp);
  const regimen = String(userData.regimen || '').replace(/\D/g, '');
  const email = String(userData.correo || userData.email || '')
    .trim()
    .toLowerCase();
  const nombre = String(userData.nombre || '')
    .trim()
    .toUpperCase();
  const uso =
    String(userData.usoCfdi || userData.usoCFDI || userData.claveUsoCfdi || 'G03')
      .trim()
      .toUpperCase();

  if (!rfc || (rfc.length !== 12 && rfc.length !== 13) || !cp || cp.length !== 5) {
    return {
      ok: false,
      error: 'datos_fiscales',
      userMessage: '⚠️ Faltan RFC válido o código postal (5 dígitos) para facturar en Walmart.',
    };
  }
  if (!regimen) {
    return {
      ok: false,
      error: 'datos_fiscales',
      userMessage: '⚠️ Hace falta el régimen fiscal (catálogo SAT) para el portal de Walmart.',
    };
  }
  if (!email || !email.includes('@')) {
    return {
      ok: false,
      error: 'email',
      userMessage: '⚠️ Se necesita un correo para recibir la factura de Walmart.',
    };
  }
  if (!nombre) {
    return {
      ok: false,
      error: 'nombre',
      userMessage: '⚠️ Falta el nombre o razón social tal como lo tienes en el SAT.',
    };
  }

  const tcClean = onlyDigits(tc);
  const trClean = onlyDigits(tr);
  if (tcClean.length < 10 || tcClean.length > 28) {
    return {
      ok: false,
      error: 'tc_invalido',
      userMessage:
        '🔍 *Código de ticket (TC#)*: debe ser el número largo bajo el código de barras (típicamente 20–24 dígitos, sin espacios).\n\n' +
        'Tómalo de la leyenda *TC#* en la parte baja del ticket.',
    };
  }
  if (trClean.length < 2 || trClean.length > 8) {
    return {
      ok: false,
      error: 'tr_invalido',
      userMessage:
        '🔍 *Número de transacción (TR#)*: suele ser 3–5 dígitos cerca de TDA/TE en el encabezado. No confundir con TDA (tienda).',
    };
  }
  const trPadded = trClean.length >= 4 ? trClean : trClean.padStart(5, '0');

  const tag = '[Walmart]';
  const headless = process.env.WALMART_HEADFUL !== '1';
  const useProxy = process.env.WALMART_USE_PROXY === '1';
  const proxy = useProxy ? getPlaywrightProxy('rotating') : undefined;
  if (useProxy) console.log(`${tag} Playwright vía PROXY_URL_ROTATING`);

  const browser = await chromium.launch({
    headless,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    proxy,
  });

  /** @type {import('playwright').Page | null} */
  let page = null;
  try {
    const context = await browser.newContext({ locale: 'es-MX', userAgent: UA, viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    page.setDefaultTimeout(25_000);

    console.log(`${tag} Cargando ${BASE}`);
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 45_000 });

    await page.locator('#ctl00_ContentPlaceHolder1_txtMemRFC').fill(rfc);
    await page.locator('#ctl00_ContentPlaceHolder1_txtCP').fill(cp);
    await page.locator('#ctl00_ContentPlaceHolder1_txtTC').fill(tcClean);
    await page.locator('#ctl00_ContentPlaceHolder1_txtTR').fill(trPadded);
    console.log(`${tag} Datos ticket: TC=${tcClean.length}d TR=${trPadded} RFC=${rfc}`);

    for (const id of ['btnInfo', 'btnTR']) {
      const el = page.locator(`#ctl00_ContentPlaceHolder1_${id}`);
      await el.waitFor({ state: 'visible', timeout: 15_000 });
      await el.click();
      await page.waitForTimeout(1500);
    }

    await Promise.all([
      page.waitForURL('**/frmRFCEdita**', { timeout: WAIT_MS }),
      page.locator('#ctl00_ContentPlaceHolder1_btnAceptar').click(),
    ]);
    console.log(`${tag} frmRFCEdita OK`);

    await page.locator('#ctl00_ContentPlaceHolder1_txtRFC').fill(rfc);
    await page.locator('#ctl00_ContentPlaceHolder1_txtRazon').fill(nombre);
    await page.locator('#ctl00_ContentPlaceHolder1_txtCP').fill(cp);
    await page.locator('#ctl00_ContentPlaceHolder1_txtEmail').fill(email);
    const selReg = page.locator('#ctl00_ContentPlaceHolder1_ddlregimenFiscal');
    try {
      await selReg.selectOption({ value: regimen });
    } catch {
      await selReg.selectOption({ label: new RegExp(regimen) });
    }
    const selUso = page.locator('select[id$="ddlusoCFDI"]');
    try {
      await selUso.selectOption({ value: uso });
    } catch {
      try {
        await selUso.selectOption({ value: uso.toLowerCase() });
      } catch {
        await page.evaluate((u) => {
          const s = /** @type {HTMLSelectElement | null} */ (document.querySelector('select[id$="ddlusoCFDI"]'));
          if (s) {
            for (const o of s.options) {
              if (o.value === u) {
                s.value = o.value;
                s.dispatchEvent(new Event('change', { bubbles: true }));
                return;
              }
            }
          }
        }, uso);
      }
    }
    await page.locator('input#ctl00_ContentPlaceHolder1_btnAceptar').first().click();
    await page.waitForTimeout(2000);

    const btnContinuar = page.locator('#ctl00_ContentPlaceHolder1_btnContinuar');
    if (await btnContinuar.isVisible().catch(() => false)) {
      const pay = page.locator('#ctl00_ContentPlaceHolder1_ddlPaymentType');
      if (await pay.count()) {
        try {
          await pay.selectOption({ value: '04' });
        } catch {
          const opts = pay.locator('option');
          const n = await opts.count();
          if (n > 1) await pay.selectOption({ index: 1 });
        }
      }
      await Promise.all([
        page.waitForURL('**/frmReportAdmin**', { timeout: WAIT_MS }),
        btnContinuar.click(),
      ]).catch(async () => {
        await btnContinuar.click();
        await page.waitForURL('**/frmReportAdmin**', { timeout: WAIT_MS });
      });
    } else {
      await page.waitForURL('**/frmReportAdmin**', { timeout: WAIT_MS });
    }
    console.log(`${tag} frmReportAdmin URL`);

    await page.locator('#ctl00_ContentPlaceHolder1_rdCorreo').check().catch(() =>
      page
        .getByRole('radio', { name: /correo|e-?mail/i })
        .check()
        .catch(() =>
          page.locator('input[name="ctl00$ContentPlaceHolder1$GroupFacturacion"][value="rdCorreo"]').check()
        )
    );
    const mailInput = page.locator('#ctl00_ContentPlaceHolder1_txtEmail');
    if (await mailInput.isVisible().catch(() => false)) {
      await mailInput.fill(email);
    }

    const errBefore = page.locator('.Error, [class*="Error"], #lblError, span[id*="lbl"]').first();
    await page.locator('#ctl00_ContentPlaceHolder1_btnFacturar').click();

    await page.waitForTimeout(4000);
    const errText = (await errBefore.isVisible().catch(() => false))
      ? (await errBefore.textContent().catch(() => '')) || ''
      : '';
    if (errText && /error|invál|no\s+v[iá]l|rechaz/i.test(errText)) {
      return {
        ok: false,
        error: 'portal_mensaje',
        userMessage: `⚠️ El portal de Walmart indica: _${errText.slice(0, 280)}_`,
      };
    }

    const body = (await page.content().catch(() => '')) || '';
    if (/error|invál|no se encontr|no encontr|caduc|vencid/i.test(body) && !/exitos|envi|correo|proceso/i.test(body)) {
      try {
        fs.mkdirSync(SHOT, { recursive: true });
        if (page) await page.screenshot({ path: path.join(SHOT, 'walmart_rechazo.png'), fullPage: true });
      } catch {}
      return {
        ok: false,
        error: 'portal_rechazo',
        userMessage:
          '⚠️ El portal de Walmart no confirmó el envío. Revisa *TC#*, *TR#*, *RFC* y *código postal*; el ticket podría estar vencido o ya facturado.\n\n' +
          'Si hace falta, intenta de nuevo o factura en facturacion.walmartmexico.com.mx (define WALMART_HEADFUL=1 en el servidor para depurar).',
      };
    }

    console.log(`${tag} OK envío por correo → ${email}`);
    return { ok: true, envioPorCorreo: true };
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    try {
      fs.mkdirSync(SHOT, { recursive: true });
      if (page) await page.screenshot({ path: path.join(SHOT, 'walmart_error.png'), fullPage: true });
    } catch {}
    if (/Timeout|timeout/i.test(msg)) {
      return {
        ok: false,
        error: 'timeout',
        userMessage:
          '⚠️ El portal de Walmart tardó demasiado o no respondió. Reintenta en unos minutos. Si usas el bot en la nube, prueba `WALMART_USE_PROXY=1` con proxy en México.',
      };
    }
    return {
      ok: false,
      error: 'walmart_error',
      userMessage: `⚠️ No pude completar la facturación en Walmart: ${msg.slice(0, 200)}`,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * @param {object} p
 * @param {string} p.noTicket — TC# (dígitos)
 * @param {string} p.tr
 * @param {object} p.userData
 */
async function facturarWalmartFromTicket(p) {
  return facturarWalmart({
    tc: p.noTicket,
    tr: p.tr,
    userData: p.userData,
  });
}

module.exports = { facturarWalmart, facturarWalmartFromTicket };
