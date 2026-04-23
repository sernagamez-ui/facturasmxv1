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
 *
 * Tiempos: el sitio usa UpdatePanel; a veces “refresca” o tarda en los postbacks. Por defecto
 * 120s por acción. Ajusta con WALMART_TIMEOUT_MS; tras el Aceptar fiscal, el bucle a frmReportAdmin
 * usa al menos 3 min (o WALMART_POST_FISCAL_MS en milis).
 *
 * Avisos emergentes: el portal muestra modales (p. ej. actualización a CFDI 4.0) que bloquean
 * el flujo; se cierran con `cerrarPopupsWalmart` + `dialog.accept()` en alert nativos.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { playwrightUseHeadless } = require('../playwrightHeadless');
const { getPlaywrightProxy } = require('../proxyAgent');

const BASE = 'https://facturacion.walmartmexico.com.mx/frmDatos.aspx';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

/** @returns {number} */
function navTimeoutMs() {
  const n = Number.parseInt(String(process.env.WALMART_TIMEOUT_MS || '120000').trim(), 10);
  return Number.isFinite(n) && n >= 30_000 ? n : 120_000;
}

/** Tras Aceptar en RFC: a veces hay varios postbacks, forma de pago, modales. */
function postFiscalWaitMs() {
  const raw = process.env.WALMART_POST_FISCAL_MS;
  if (raw != null && String(raw).trim() !== '') {
    const n = Number.parseInt(String(raw).trim(), 10);
    if (Number.isFinite(n) && n >= 60_000) return n;
  }
  return Math.max(navTimeoutMs(), 180_000);
}

const SHOT = process.env.WALMART_SCREENSHOT_DIR || '/tmp';

/**
 * Espera el POST de ASP.NET (AJAX) típico del UpdatePanel tras un click.
 * @param {import('playwright').Page} p
 * @param {string | string[]} pathFragment — ej. frmDatos, o varías asp con UpdatePanel
 * @param {number} t
 */
async function waitForAjaxPost(p, pathFragment, t) {
  const list = (Array.isArray(pathFragment) ? pathFragment : [pathFragment]).map((s) =>
    String(s || '').toLowerCase()
  );
  const matchUrl = (u) => {
    const n = (u || '').toLowerCase();
    return list.some((frag) => n.includes(frag));
  };
  try {
    await p.waitForResponse(
      (r) =>
        r.url().includes('walmartmexico.com.mx') &&
        r.request().method() === 'POST' &&
        r.status() < 500 &&
        matchUrl(r.url()),
      { timeout: t }
    );
  } catch {
    /* algunos clics hacen navegación completa en vez de solo Delta */
  }
  await p.waitForTimeout(700);
}

/**
 * alert/confirm/prompt del navegador (raro pero posible en WebForms viejos).
 * @param {import('playwright').Page} page
 */
function attachWalmartDialogHandler(page) {
  page.on('dialog', async (dialog) => {
    try {
      await dialog.accept();
    } catch {
      /* */
    }
  });
}

/**
 * Modales internos: avisos de CFDI 4.0, términos, “Entendido”, etc. (bloquean clics al formulario).
 * @param {import('playwright').Page} page
 * @param {string} tag
 */
async function cerrarPopupsWalmart(page, tag) {
  const labelBtn =
    /^(Aceptar|Acepto|Entendido|Entiendo|De acuerdo|Cerrar|OK|Continuar|Siguiente|Confirmar)$/i;
  let cerrados = 0;

  for (let ronda = 0; ronda < 10; ronda++) {
    let hubo = false;

    const contenedores = page.locator(
      [
        '[role="dialog"]',
        '.ui-dialog:visible',
        '[class*="modal-dialog"]:visible',
        '[class*="Modal"]:visible',
        '[id*="Mensaje"]:visible',
        '[id*="Popup"]:visible',
        '[id*="modal"]:visible',
      ].join(', ')
    );

    const nC = await contenedores.count();
    for (let i = 0; i < Math.min(nC, 5); i++) {
      const box = contenedores.nth(i);
      if (!(await box.isVisible().catch(() => false))) continue;
      const btn = box
        .locator('button, input[type="button"], input[type="submit"], a[href="#"], a[role="button"]')
        .filter({ hasText: /aceptar|entendido|acepto|cerrar|de acuerdo|ok|continuar|siguiente|confirmar/i });
      if (await btn.first().isVisible().catch(() => false)) {
        await btn.first().click({ timeout: 4_000 }).catch(() => {});
        hubo = true;
        cerrados++;
        await page.waitForTimeout(500);
        break;
      }
    }

    if (!hubo) {
      const generico = page.getByRole('button', { name: labelBtn });
      const gc = await generico.count();
      for (let j = 0; j < Math.min(gc, 12); j++) {
        const b = generico.nth(j);
        if (!(await b.isVisible().catch(() => false))) continue;
        const inDialog = await b.evaluate(
          (el) =>
            !!el.closest(
              '[role="dialog"], .ui-dialog, [class*="modal"], [id*="Mensaje"], [id*="Popup"], [id*="Aviso"]'
            )
        ).catch(() => false);
        const inBlock = inDialog
          || (await b
            .evaluate(
              (el) =>
                !!el.closest(
                  '[class*="overlay"], [id*="Mensaje"], [id*="Popup"], [id*="Aviso"], [class*="modal"]'
                )
            )
            .catch(() => false));
        if (inBlock) {
          await b.click({ timeout: 4_000 }).catch(() => {});
          hubo = true;
          cerrados++;
          await page.waitForTimeout(500);
          break;
        }
      }
    }

    if (!hubo) {
      const alts = page.locator('input[type="button"][value], input[type="submit"][value]');
      const ac = await alts.count();
      for (let k = 0; k < Math.min(ac, 20); k++) {
        const inp = alts.nth(k);
        const v = (await inp.getAttribute('value').catch(() => '')) || '';
        if (!/aceptar|entendido|acepto|cerrar|ok|continuar|siguiente/i.test(v)) continue;
        if (!(await inp.isVisible().catch(() => false))) continue;
        const inOvl = await inp
          .evaluate((el) =>
            !!el.closest(
              '[role="dialog"], .ui-dialog, [class*="modal"], [id*="Mensaje"], [id*="Popup"], [class*="overlay"]'
            )
          )
          .catch(() => false);
        if (inOvl) {
          await inp.click({ timeout: 4_000 }).catch(() => {});
          hubo = true;
          cerrados++;
          await page.waitForTimeout(500);
          break;
        }
      }
    }

    if (!hubo) break;
  }

  if (cerrados > 0) console.log(`${tag} modales/avisos cerrados (${cerrados} clic[s])`);
  await clicCapasZIndexWalmart(page, tag);
}

/**
 * Avisos Walmex a menudo son divs con position:fixed/absolute y z-index, sin [role=dialog]
 * (p. ej. wizards, barras, CFDI). Clic en Aceptar/Continuar/Siguiente solo si está en capa
 * superpuesta; no pisa el Aceptar principal del flujo de ticket (frmDatos) si está al fondo.
 *
 * @param {import('playwright').Page} page
 * @param {string} tag
 */
async function clicCapasZIndexWalmart(page, tag) {
  for (let a = 0; a < 4; a++) {
    const label = await page.evaluate(() => {
      const re =
        /^(Aceptar|Acepto|Entendido|Entiendo|Continuar|Siguiente|Cerrar|OK|De acuerdo|Confirmar|Ir\s+al\s+inicio)$/i;
      const nodes = document.querySelectorAll('button, input[type="button"], input[type="submit"], a[href]');
      function maxZBelow(el) {
        let m = 0;
        for (let x = el; x && x !== document.body; x = x.parentElement) {
          const st = getComputedStyle(x);
          const z = parseInt(st.zIndex, 10) || 0;
          if (z > m) m = z;
        }
        return m;
      }
      function inOverlayish(el) {
        if (el.closest('[role="dialog"]')) return true;
        for (let p = el; p && p !== document.body; p = p.parentElement) {
          const id = (p.id || '') + (p.className && p.className.toString ? p.className : '');
          if (/Mensaje|Popup|Aviso|ui-dialog|modal|overlay|mask|bpopup|jconfirm|wizzard|wizard|banner/i.test(id))
            return true;
          const s = getComputedStyle(p);
          const z = parseInt(s.zIndex, 10) || 0;
          if (s.position === 'fixed' && z > 0 && p !== el) {
            const br = p.getBoundingClientRect();
            if (br.width > 180 && br.height > 50) return true;
          }
        }
        if (maxZBelow(el) >= 50) return true;
        return false;
      }
      for (const el of Array.from(nodes)) {
        if (!el || !(el).offsetParent) continue;
        const t = ((el).textContent || (el).value || (el).innerText || '')
          .replace(/\s+/g, ' ')
          .trim();
        if (!t || !re.test(t)) continue;
        const id = (el).id || '';
        if (id === 'ctl00_ContentPlaceHolder1_btnAceptar' || id.includes('ContentPlaceHolder1_btnAceptar')) {
          if (!inOverlayish(el)) continue;
        }
        if (t.match(/^(Continuar|Siguiente)$/i)) {
          if (!inOverlayish(el)) {
            const r = el.getBoundingClientRect();
            if (!(r.width > 100 && r.height > 20 && r.top < window.innerHeight * 0.35 && r.top >= 0)) {
              continue;
            }
            /* CTA en franja superior (común en avisos a pantalla completa) */
          }
        } else if (!inOverlayish(el)) {
          continue;
        }
        try {
          el.click();
        } catch {
          return null;
        }
        return t;
      }
      return null;
    });
    if (!label) break;
    console.log(`${tag} capa z-index/overlay: clic "${label}"`);
    await page.waitForTimeout(600);
  }
}

/**
 * Repite cierre: muchos modales se encadenan (CFDI → continuar → otro aviso).
 * @param {import('playwright').Page} page
 * @param {string} tag
 * @param {number} rondas
 */
async function despejarAvisosWalmart(page, tag, rondas = 5) {
  for (let i = 0; i < rondas; i++) {
    await cerrarPopupsWalmart(page, tag);
    await page.waitForTimeout(250);
  }
}

/**
 * Tras "Aceptar" en datos fiscales: el portal puede (a) ir a frmReportAdmin, (b) mostrar
 * "ya facturado" / error sin cambiar de URL, (c) mostrar "Continuar" (forma de pago).
 * No uses solo waitForURL(frmReportAdmin) — si (b), hace timeout inútil.
 * Pueden requerirse **varios** "Continuar" (forma de pago / asistentes); antes solo se hacía 1.
 *
 * @param {import('playwright').Page} page
 * @param {number} maxMs
 * @param {string} tag
 */
async function esperarReportAdminTrasFiscal(page, maxMs, tag) {
  const reYaFacturado =
    /ya\s+(se\s+encuentra\s+)?factur|facturad[oa]\s+previamente|previamente\s+factur|no\s+puede\s+emitir\s+.*\s+nuev|comprobante\s+fiscal\s+.*\s+(generad|emitid)|duplicad[oa].*factur|ya\s+existe\s+un\s+comprobante/i;
  const rePortalNeg =
    /no\s+se\s+encontr[oó]\s+el\s+(ticket|comprobante|registro)|ticket\s+no\s+v[aá]lid|no\s+v[aá]lido\s+para\s+factur|plazo\s+de\s+facturaci[oó]n\s+vencid|operaci[oó]n\s+no\s+v[aá]lid/i;
  const urlEsReportAdmin = (u) => (u || '').toLowerCase().includes('frmreportadmin');
  const MAX_CONTINUAR = 10;
  const t0 = Date.now();
  let continuarClicks = 0;
  let tick = 0;

  while (Date.now() - t0 < maxMs) {
    tick += 1;
    if (tick % 2 === 0) await despejarAvisosWalmart(page, tag, 2);
    const url = page.url();
    if (urlEsReportAdmin(url)) return { kind: 'admin' };

    let head = '';
    try {
      head = await page.evaluate(() =>
        document.body && document.body.innerText ? document.body.innerText.slice(0, 16_000) : ''
      );
    } catch {
      /* DOM inestable durante postback */
    }

    if (reYaFacturado.test(head)) {
      const m = head.match(/.{0,100}(factur|previamente|comprobante|duplicad|emitid).{0,180}/i);
      return { kind: 'ya_facturado', hint: (m && m[0] ? m[0] : head).trim().slice(0, 320) };
    }
    if (rePortalNeg.test(head)) {
      return { kind: 'portal', hint: head.slice(0, 480) };
    }

    const btnC = page.locator('#ctl00_ContentPlaceHolder1_btnContinuar');
    if (continuarClicks < MAX_CONTINUAR && (await btnC.isVisible().catch(() => false))) {
      const pay = page.locator('#ctl00_ContentPlaceHolder1_ddlPaymentType');
      if (await pay.count()) {
        try {
          await pay.selectOption({ value: '04' });
        } catch {
          try {
            const n = await pay.locator('option').count();
            if (n > 1) await pay.selectOption({ index: 1 });
          } catch {
            /* una sola opción */
          }
        }
      }
      await despejarAvisosWalmart(page, tag, 1);
      try {
        await btnC.scrollIntoViewIfNeeded({ timeout: 6_000 });
      } catch {
        /* */
      }
      console.log(`${tag} Continuar (forma de pago) [${continuarClicks + 1}/${MAX_CONTINUAR}]`);
      await btnC.click({ timeout: 25_000 });
      continuarClicks += 1;
      const restPost = Math.min(95_000, maxMs - (Date.now() - t0) - 500);
      await waitForAjaxPost(
        page,
        ['frmrfcedita', 'frmreportadmin', 'frmdatos'],
        Math.max(5_000, restPost)
      );
      const restRace = Math.max(4_000, maxMs - (Date.now() - t0) - 500);
      await Promise.race([
        page.waitForURL(/frmreportadmin/i, { timeout: restRace }),
        page.locator('#ctl00_ContentPlaceHolder1_btnContinuar').waitFor({ state: 'hidden', timeout: Math.min(32_000, restRace) }),
      ]).catch(() => {});
      await despejarAvisosWalmart(page, tag, 1);
      if (urlEsReportAdmin(page.url())) return { kind: 'admin' };
      await page.waitForTimeout(600);
      continue;
    }

    await page.waitForTimeout(450);
  }

  return { kind: 'timeout' };
}

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
  const headless = playwrightUseHeadless(process.env.WALMART_HEADFUL, tag, 'WALMART_HEADFUL');
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
  const T = navTimeoutMs();
  try {
    const context = await browser.newContext({ locale: 'es-MX', userAgent: UA, viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    attachWalmartDialogHandler(page);
    page.setDefaultTimeout(T);
    page.setDefaultNavigationTimeout(T);
    console.log(`${tag} timeout acciones ${T}ms (WALMART_TIMEOUT_MS)`);

    console.log(`${tag} Cargando ${BASE}`);
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: T });
    await page.waitForTimeout(1000);
    await despejarAvisosWalmart(page, tag, 6);
    await page.locator('#ctl00_ContentPlaceHolder1_txtTC').waitFor({ state: 'visible', timeout: T });
    await page.waitForTimeout(400);
    await despejarAvisosWalmart(page, tag, 2);

    await page.locator('#ctl00_ContentPlaceHolder1_txtMemRFC').fill(rfc);
    await page.locator('#ctl00_ContentPlaceHolder1_txtCP').fill(cp);
    await page.locator('#ctl00_ContentPlaceHolder1_txtTC').fill(tcClean);
    await page.locator('#ctl00_ContentPlaceHolder1_txtTR').fill(trPadded);
    console.log(`${tag} Datos ticket: TC=${tcClean.length}d TR=${trPadded} RFC=${rfc}`);

    for (const id of ['btnInfo', 'btnTR']) {
      await cerrarPopupsWalmart(page, tag);
      const el = page.locator(`#ctl00_ContentPlaceHolder1_${id}`);
      await el.waitFor({ state: 'visible', timeout: T });
      await el.click();
      await waitForAjaxPost(page, 'frmDatos', T);
      await cerrarPopupsWalmart(page, tag);
    }

    await Promise.all([
      page.waitForURL('**/frmRFCEdita**', { timeout: T }),
      page.locator('#ctl00_ContentPlaceHolder1_btnAceptar').click(),
    ]);
    await cerrarPopupsWalmart(page, tag);
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
    await waitForAjaxPost(page, ['frmrfcedita', 'frmreportadmin'], T);
    await page.waitForTimeout(1200);

    const tPost = postFiscalWaitMs();
    console.log(`${tag} panel envío: tiempo máx. post-fiscal ${(tPost / 1000).toFixed(0)}s (WALMART_POST_FISCAL_MS si está definida)`);
    const postFiscal = await esperarReportAdminTrasFiscal(page, tPost, tag);
    if (postFiscal.kind === 'ya_facturado') {
      return {
        ok: false,
        error: 'ya_facturado',
        userMessage:
          '📋 *Este ticket de Walmart ya fue facturado* (o el portal no permite otro CFDI para la misma compra).\n\n' +
          (postFiscal.hint ? `_${postFiscal.hint}_\n\n` : '') +
          'Revisa tu correo por el XML/PDF anterior o prueba con un ticket que aún no se haya timbrado.',
      };
    }
    if (postFiscal.kind === 'portal') {
      return {
        ok: false,
        error: 'portal_mensaje',
        userMessage: `⚠️ Walmart: _${postFiscal.hint.slice(0, 520)}_`,
      };
    }
    if (postFiscal.kind !== 'admin') {
      let snip = '';
      try {
        snip = await page.evaluate(() =>
          document.body && document.body.innerText ? document.body.innerText.slice(0, 2500) : ''
        );
      } catch {
        snip = '';
      }
      console.error(`${tag} timeout sin frmReportAdmin url=${page.url()} snippet=${snip.slice(0, 500)}`);
      try {
        fs.mkdirSync(SHOT, { recursive: true });
        if (page) await page.screenshot({ path: path.join(SHOT, 'walmart_timeout_post_fiscal.png'), fullPage: true });
      } catch {
        /* */
      }
      return {
        ok: false,
        error: 'timeout',
        userMessage:
          '⚠️ El portal no pasó a la pantalla de envío a tiempo. Si el ticket *ya estaba facturado* o faltan pasos (forma de pago / Continuar), el sitio a veces se queda atrás.\n\n' +
            'Prueba de nuevo, sube `WALMART_POST_FISCAL_MS` (p. ej. 300000) o `WALMART_TIMEOUT_MS` en el servidor, y revisa `walmart_timeout_post_fiscal.png` (WALMART_SCREENSHOT_DIR) con `WALMART_HEADFUL=1` en local si hace falta.',
      };
    }
    console.log(`${tag} frmReportAdmin URL`);
    await cerrarPopupsWalmart(page, tag);

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
    await cerrarPopupsWalmart(page, tag);
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
      if (page) console.error(`${tag} error url=${page.url()} → ${msg.slice(0, 500)}`);
    } catch {
      /* */
    }
    try {
      fs.mkdirSync(SHOT, { recursive: true });
      if (page) await page.screenshot({ path: path.join(SHOT, 'walmart_error.png'), fullPage: true });
    } catch {}
    if (/Timeout|timeout/i.test(msg)) {
      let ya = false;
      try {
        if (page) {
          const t = await page.evaluate(() =>
            document.body && document.body.innerText ? document.body.innerText.slice(0, 12_000) : ''
          );
          ya = /ya\s+.*factur|facturad[oa]\s+previamente|previamente\s+factur/i.test(t);
          if (ya) {
            return {
              ok: false,
              error: 'ya_facturado',
              userMessage:
                '📋 Parece que *este ticket de Walmart ya estaba facturado* (detectado al cortar por tiempo de espera).\n\n' +
                  'Confirma en el portal o en tu correo el XML anterior.',
            };
          }
        }
      } catch {
        /* */
      }
      return {
        ok: false,
        error: 'timeout',
        userMessage:
          '⚠️ El portal de Walmart tardó demasiado (UpdatePanel o sesión lenta). ' +
            'Reintenta; en local prueba `WALMART_TIMEOUT_MS=180000` o `WALMART_HEADFUL=1`. ' +
            'En la nube, `WALMART_USE_PROXY=1` con proxy en México si el host está lejos del portal.',
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
