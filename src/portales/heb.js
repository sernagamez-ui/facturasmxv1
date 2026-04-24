/**
 * Adaptador HEB — facturacion.heb.com.mx
 * Basado en el flujo que timbraba con: waitForResponse(timbrar) + consulta_factura (ver heb.js original).
 * Las promesas se registran ANTES del click para no perder la respuesta (race en datacenters rápidos).
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { playwrightUseHeadless } = require('../playwrightHeadless');

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
  // No descartar si ya viene el XML: algunos despliegues regresan timbrado + documento en un solo JSON.
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
        if (!u.includes('facturacion.heb.com.mx')) return;
        if (!u.toLowerCase().includes('api')) return;
        const req = res.request();
        if (isExcludedHebPreTimbrarUrl(u.toLowerCase(), req)) return;
        const st = res.status();
        if (st < 200 || st >= 500) return;
        const ct = (res.headers()['content-type'] || '').toLowerCase();
        if (ct && !ct.includes('json') && !ct.includes('text')) return;
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

function isExcludedHebForDocumentoUrl(u, req) {
  if (req.method() !== 'POST') return true;
  const l = u.toLowerCase();
  for (const ex of [
    'int_store_sel',
    'int_ticket_sel',
    'consulta_ticket_forma_pago',
    'consulta_facturas_uuid',
  ]) {
    if (l.includes(ex)) return true;
  }
  return false;
}

function looksLikeHebDocumentoJson(j) {
  return !!j?.list_facturas?.[0]?.document?.xml;
}

/**
 * Escucha un JSON con list_facturas[].document.xml (misma lógica que el timbrado, sin
 * page.waitForResponse — evita TimeoutError de Playwright en consulta de documento).
 * Regístrala antes de "Generar factura" y úsala después del timbrado, o llama a abort() si
 * el timbrado ya trae XML+PDF.
 * @param {import('playwright').Page} page
 * @param {number} timeoutMs
 * @returns {{ promise: Promise<Record<string, unknown>>, abort: () => void }}
 */
function startHebDocumentoWait(page, timeoutMs) {
  let done = false;
  /** @type {((res: import('playwright').Response) => Promise<void>) | null} */
  let onResponse = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let tid;
  /** @type {((j: Record<string, unknown> | null) => void) | null} */
  let settle = null;
  const promise = new Promise((resolve, reject) => {
    settle = (j) => {
      if (done) return;
      done = true;
      if (onResponse) page.removeListener('response', onResponse);
      if (tid) clearTimeout(tid);
      if (j) resolve(j);
      else resolve(null);
    };
    onResponse = async (res) => {
      if (done) return;
      try {
        const u = res.url();
        if (!u.includes('facturacion.heb.com.mx')) return;
        if (!u.toLowerCase().includes('api')) return;
        const req = res.request();
        if (isExcludedHebForDocumentoUrl(u, req)) return;
        const st = res.status();
        if (st < 200 || st >= 500) return;
        const ct = (res.headers()['content-type'] || '').toLowerCase();
        if (ct && !ct.includes('json') && !ct.includes('text')) return;
        const j = await res.json();
        if (!looksLikeHebDocumentoJson(j)) return;
        settle(/** @type {Record<string, unknown>} */ (j));
      } catch {
        // body no-JSON o consumido
      }
    };
    page.on('response', onResponse);
    tid = setTimeout(() => {
      if (done) return;
      if (onResponse) page.removeListener('response', onResponse);
      done = true;
      reject(
        new Error(
          `HEB timeout: sin API con XML de factura en ${timeoutMs / 1000}s. HEB_DEBUG_API=1, heb_step6.png, HEB_HEADFUL=1`
        )
      );
    }, timeoutMs);
  });
  return {
    promise,
    abort() {
      if (settle) settle(null);
    },
  };
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Saca un array de filas de las respuestas get_* del portal (formas varían).
 * @param {unknown} j
 * @returns {Array<Record<string, unknown>>}
 */
function hebRowsFromCatalogJson(j) {
  if (!j || typeof j !== 'object') return [];
  if (Array.isArray(j)) return j;
  const o = j;
  for (const k of ['rows', 'data', 'list', 'regimenFiscal', 'usosCfdi', 'items', 'regimenFiscales']) {
    const v = o[k];
    if (Array.isArray(v)) return v;
  }
  if (o.result && typeof o.result === 'object') {
    for (const k of ['rows', 'data', 'list']) {
      if (Array.isArray(o.result[k])) return o.result[k];
    }
  }
  if (o.data && typeof o.data === 'object' && o.data !== null) {
    const d = o.data;
    for (const k of ['rows', 'list', 'data']) {
      if (Array.isArray(d[k])) return d[k];
    }
  }
  return [];
}

/**
 * @param {Record<string, unknown>} row
 * @param {string} want
 */
function hebRowClaveIs(row, want) {
  const w = String(want).trim();
  const wu = w.toUpperCase();
  for (const k of [
    'c_RegimenFiscal',
    'c_regimenFiscal',
    'c_RegFiscal',
    'c_Clave',
    'c_ClaveRegFiscalC',
    'c_UsoCfdi',
    'c_UsoCFDI',
    'UsoCfdI',
    'UsoCfdi',
    'c_Uso',
    'Clave',
    'CLAVE',
    'clave',
    'codigo',
    'id',
  ]) {
    if (row[k] == null) continue;
    const s = String(row[k]).trim();
    if (s === w || s.toUpperCase() === wu) return true;
  }
  for (const [k, v] of Object.entries(row)) {
    if (v == null) continue;
    const s = String(v).trim();
    if (s === w && /(fiscal|regimen|clave|uso|cfdi|cve|cod|id)/i.test(k)) return true;
  }
  return false;
}

/**
 * @param {Record<string, unknown>} row
 * @param {string} clave
 */
function hebRowLabelForForm(row, clave) {
  const c = String(clave);
  const desc =
    String(
      row.descripcion ??
        row.Descripcion ??
        row.nombre ??
        row.nombreCfdi ??
        row.descrip ??
        row.label ??
        ''
    ).trim();
  if (desc && (desc.toUpperCase().includes(c) || new RegExp(`\\b${escapeRegExp(c)}\\b`, 'i').test(desc)))
    return desc;
  if (desc) return `${c} - ${desc}`.replace(/\s+-\s*-\s+/, ' - ').replace(`${c} - ${c} - `, `${c} - `);
  return c;
}

/**
 * @param {Record<string, unknown>} cap
 * @param {'regimen' | 'uso_cfdi'} fileTag
 * @param {string} code
 * @returns {string | null} texto para tipear y filtrar (descripción o "clave - descripción")
 */
function hebCatalogTextHint(cap, fileTag, code) {
  const c = String(code).trim();
  if (!c) return null;
  const j = fileTag === 'regimen' ? cap.regimenFiscalJson : cap.usoCfdiJson;
  if (!j) {
    if (HEB_DEBUG_API) {
      console.log(
        `[HEB] catálogo ${fileTag}: no interceptado (espera GET ${
          fileTag === 'regimen' ? 'regimen_fiscal' : 'uso_cfdi_sel'
        })`
      );
    }
    return null;
  }
  const rows = hebRowsFromCatalogJson(j);
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (!hebRowClaveIs(row, c)) continue;
    const t = hebRowLabelForForm(/** @type {Record<string, unknown>} */ (row), c);
    if (t) {
      if (HEB_DEBUG_API) console.log('[HEB] catálogo fila', fileTag, String(t).slice(0, 100));
    }
    return t;
  }
  if (HEB_DEBUG_API) console.log('[HEB] catálogo', fileTag, 'no halló clave', c, 'n=', rows.length);
  return null;
}

/**
 * Varios PNG para Telegram/diagnóstico: página, campo y panel del autocomplete.
 * @param {import('playwright').Page} page
 * @param {import('playwright').Locator} inputLoc
 * @param {string} fileTag
 */
async function hebFiscalDebugScreenshots(page, inputLoc, fileTag) {
  const base = `heb_fiscal_${fileTag}`;
  try {
    await inputLoc.scrollIntoViewIfNeeded();
  } catch {
    // noop
  }
  try {
    await page.screenshot({
      path: hebScreenshotPath(`${base}_full.png`),
      fullPage: true,
      animations: 'disabled',
    });
  } catch (e) {
    console.log('[HEB] screenshot full:', (e && e.message) || e);
  }
  try {
    const field = page.locator('mat-form-field').filter({ has: inputLoc }).first();
    if (await field.count() > 0) {
      await field.screenshot({ path: hebScreenshotPath(`${base}_field.png`) });
    } else {
      await inputLoc.screenshot({ path: hebScreenshotPath(`${base}_field.png`) });
    }
  } catch (e) {
    try {
      await inputLoc.screenshot({ path: hebScreenshotPath(`${base}_field.png`) });
    } catch {
      // noop
    }
  }
  try {
    const panel = page
      .locator('.cdk-overlay-container .mat-mdc-autocomplete-panel, .cdk-overlay-pane, .mdc-menu-surface')
      .last();
    if (await panel.isVisible().catch(() => false)) {
      await panel.screenshot({ path: hebScreenshotPath(`${base}_panel.png`) });
    }
  } catch {
    // noop
  }
  try {
    const list = page.locator(
      'cdk-overlay-container mat-mdc-option, cdk-overlay-container mat-option, cdk-overlay-container [role=option]'
    );
    const m = await list.count();
    const bits = [];
    for (let i = 0; i < Math.min(m, 25); i++) {
      const t = ((await list.nth(i).textContent()) || '').replace(/\s+/g, ' ').trim();
      if (t) bits.push(t.substring(0, 160));
    }
    console.log(
      `[HEB] mat-option/MDC en overlay (hasta 25, texto; puede no ser visible en Playwright): ` +
        JSON.stringify(bits)
    );
  } catch {
    // noop
  }
}

/**
 * Input de autocomplete (régimen / uso CFDI): localizar mat-form-field por etiqueta; si no, nth global.
 * Evita `fi.nth(3)` desfasado por inputs extra o orden distinto en producción.
 * @param {import('playwright').Page} page
 * @param {import('playwright').Locator} fi
 * @param {RegExp} labelRe
 * @param {number} nthFallback
 */
function hebFiscalTaxAutocompleteInput(page, fi, labelRe, nthFallback) {
  return page
    .locator('mat-form-field')
    .filter({ hasText: labelRe })
    .locator('input')
    .first()
    .or(fi.nth(nthFallback));
}

/**
 * Todos los nodos de lista que suelen pintar HEB/Angular 15+ (mdc) en el overlay.
 * @param {import('playwright').Page} page
 */
function hebAutocompleteOptions(page) {
  return page.locator(
    'cdk-overlay-container mat-option, cdk-overlay-container mat-mdc-option, mat-option, mat-mdc-option, [role=option]'
  );
}

/**
 * Parte descriptiva del renglón del catálogo (después de "601 -" o "G03 -") para filtrar sin depender
 * de que el mat-option muestre el número al inicio.
 * @param {string} textHint
 */
function hebLabelWithoutClave(textHint) {
  const s = String(textHint || '').trim();
  if (!s) return '';
  if (s.includes(' - ')) {
    return s
      .split(/\s*-\s*/)
      .slice(1)
      .join(' - ')
      .trim();
  }
  return s;
}

/**
 * Rellena el input de mat-autocomplete de forma que Angular reaccione (fill a veces no abre el panel).
 * @param {import('playwright').Page} page
 * @param {import('playwright').Locator} inputLoc
 * @param {string} text
 */
async function hebMatInputType(page, inputLoc, text) {
  const t = String(text);
  await inputLoc.click();
  await inputLoc.fill('');
  await page.waitForTimeout(120);
  if (t.length < 200) {
    await inputLoc.pressSequentially(t, { delay: 22 });
  } else {
    await inputLoc.fill(t);
  }
  await page.waitForTimeout(520);
}

/**
 * Clic en la opción cuyo texto contiene la descripción (o el código) buscada.
 * @param {import('playwright').Page} page
 * @param {string} code
 * @param {string} textHint
 */
async function hebClickMatOptionFuzzyInDom(page, code, textHint) {
  const noClave = hebLabelWithoutClave(textHint);
  return page.evaluate(
    ([c, desc]) => {
      const n = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
      const all = document.querySelectorAll('mat-option, mat-mdc-option, [role=option]');
      const esc = String(c).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const reC = new RegExp(`\\b${esc}\\b`, 'i');
      const d = n(desc);
      const words = d.split(/\s+/).filter((w) => w.length > 2);
      const short = words.slice(0, 5).join(' ');

      for (const el of all) {
        const t = n((el.textContent || ''));
        if (!t) continue;
        if (reC.test(t)) {
          el.scrollIntoView({ block: 'center', inline: 'nearest' });
          el.click();
          return true;
        }
      }
      if (d.length < 5) return false;
      for (const el of all) {
        const t = n((el.textContent || ''));
        if (!t) continue;
        if (d.length >= 10 && t.includes(d.slice(0, 36))) {
          el.scrollIntoView({ block: 'center', inline: 'nearest' });
          el.click();
          return true;
        }
        if (short.length >= 10 && t.includes(short)) {
          el.scrollIntoView({ block: 'center', inline: 'nearest' });
          el.click();
          return true;
        }
      }
      return false;
    },
    [String(code), noClave || String(textHint)]
  );
}

/**
 * Escribe código en el input y, si al filtrar el panel se vacía, abre de nuevo (vacío + flechas) y busca por texto.
 * @param {import('playwright').Page} page
 * @param {import('playwright').Locator} inputLoc
 * @param {string} c
 * @param {string} fileTag
 * @param {{ openUnfiltered: boolean, fuzzyHint?: string }} opts
 */
async function hebClickOptionByCodeInPanel(page, inputLoc, c, fileTag, opts) {
  const reWord = new RegExp(`\\b${escapeRegExp(c)}\\b`, 'i');
  const reStart = new RegExp(`^\\s*${escapeRegExp(c)}\\b`, 'i');
  const fuzzy = opts.fuzzyHint ? hebLabelWithoutClave(opts.fuzzyHint) : '';
  const collectVisibleTexts = async () => {
    const loc = hebAutocompleteOptions(page);
    const n = await loc.count();
    const rows = [];
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      const raw = (await el.textContent()) || '';
      const txt = raw.replace(/\s+/g, ' ').trim();
      if (txt) rows.push({ el, txt });
    }
    return rows;
  };

  const tryClick = async (rows) => {
    for (const { el, txt } of rows) {
      const up = txt.toUpperCase();
      if (
        reStart.test(txt) ||
        reWord.test(txt) ||
        up.startsWith(c.toUpperCase() + ' ') ||
        up.startsWith(c.toUpperCase() + ' -') ||
        up.startsWith(c.toUpperCase() + ' –') ||
        up.startsWith(c.toUpperCase() + '—') ||
        up.startsWith(c.toUpperCase() + '-')
      ) {
        await el.click();
        console.log(`[HEB] ${fileTag} OK:`, txt.slice(0, 120));
        await page.waitForTimeout(200);
        return true;
      }
    }
    return false;
  };

  const tryFuzzy = async (rows) => {
    if (!fuzzy || fuzzy.length < 6) return false;
    const nF = fuzzy.replace(/\s+/g, ' ').toLowerCase();
    const head = nF.slice(0, 44);
    const five = nF
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .slice(0, 5)
      .join(' ');
    for (const { el, txt } of rows) {
      const t = txt.replace(/\s+/g, ' ').toLowerCase();
      if (head.length >= 10 && t.includes(head)) {
        await el.click();
        console.log(`[HEB] ${fileTag} OK (fuzzy desc):`, txt.slice(0, 120));
        await page.waitForTimeout(200);
        return true;
      }
      if (five.length >= 10 && t.includes(five)) {
        await el.click();
        console.log(`[HEB] ${fileTag} OK (fuzzy 5 palabras):`, txt.slice(0, 120));
        await page.waitForTimeout(200);
        return true;
      }
    }
    return false;
  };

  if (opts.openUnfiltered) {
    await inputLoc.click();
    await inputLoc.fill('');
    await page.waitForTimeout(250);
    for (let a = 0; a < 4; a += 1) {
      await inputLoc.press('ArrowDown').catch(() => {});
      await page.waitForTimeout(400);
    }
    await page.waitForTimeout(300);
  }

  let rows = await collectVisibleTexts();
  if (rows.length === 0) {
    const panel = page
      .locator('.cdk-overlay-container .mdc-list, .mat-mdc-autocomplete-panel, .cdk-overlay-pane .mat-mdc-select-panel')
      .first();
    if (await panel.isVisible().catch(() => false)) {
      await panel.evaluate((el) => {
        el.scrollTop = 0;
        el.scrollTo(0, 0);
      });
      for (let s = 0; s < 6; s += 1) {
        await panel.evaluate((el) => {
          el.scrollBy(0, 200);
        });
        await page.waitForTimeout(120);
        rows = await collectVisibleTexts();
        if (rows.length > 0) break;
      }
    }
  }

  if (await tryClick(rows)) return true;
  if (await tryFuzzy(rows)) return true;
  return false;
}

/**
 * Click en la opción que contenga el código como palabra (incluye overlay y nodos aún no “visibles” para Playwright).
 * @param {import('playwright').Page} page
 * @param {string} c
 */
/** Cuenta opciones en el overlay (MDC, legacy, role=option). */
async function hebCountOverlayOptions(page) {
  return page
    .locator(
      'cdk-overlay-container mat-mdc-option, cdk-overlay-container mat-option, cdk-overlay-container [role=option]'
    )
    .count();
}

/**
 * Clic en el botón de sufijo (X) recorriendo el DOM con closest(mat-form-field).
 * Más fiable en headless que filter({ has: inputLoc }).
 * @param {import('playwright').Locator} inputLoc
 * @returns {Promise<boolean>}
 */
async function hebClickMatSuffixXFromInputDom(inputLoc) {
  const clicked = await inputLoc.evaluate((el) => {
    if (!el || !(el instanceof HTMLInputElement)) return false;
    const ff = el.closest('mat-form-field');
    if (!ff) return false;
    const sel =
      '.mat-mdc-text-field-suffix button, .mat-mdc-form-field-suffix button, ' +
      'mat-suffix button, [class*="text-field-suffix"] button, ' +
      'button.mat-mdc-icon-button, button[mat-icon-button]';
    const list = /** @type {NodeListOf<HTMLButtonElement>} */ (ff.querySelectorAll(sel));
    for (const btn of list) {
      btn.click();
      return true;
    }
    const any = /** @type {NodeListOf<HTMLButtonElement>} */ (ff.querySelectorAll('button'));
    if (any.length) {
      any[any.length - 1].click();
      return true;
    }
    return false;
  });
  if (clicked && HEB_DEBUG_API) {
    console.log('[HEB] Clic en X (sufijo) vía DOM en mat-form-field del input');
  }
  return !!clicked;
}

/**
 * HEB: en customer-tax-data el desplegable del mat-autocomplete abre al pulsar la "X" (sufijo / limpiar)
 * en el mat-form-field (como en navegador manual), no solo con ArrowDown.
 * @param {import('playwright').Locator} inputLoc
 * @returns {Promise<boolean>} true si se hizo clic en un botón de sufijo
 */
async function hebClickMatSuffixClearForAutocomplete(inputLoc) {
  if (await hebClickMatSuffixXFromInputDom(inputLoc)) {
    return true;
  }
  const page = inputLoc.page();
  const field = page.locator('mat-form-field').filter({ has: inputLoc }).first();
  if ((await field.count()) === 0) return false;

  const inSuffix = field.locator(
    '.mat-mdc-text-field-suffix, .mat-mdc-form-field-suffix, mat-suffix'
  );
  const suffixButtons = inSuffix.locator('button');
  const n = await suffixButtons.count();
  for (let i = 0; i < n; i++) {
    const b = suffixButtons.nth(i);
    if (await b.isVisible().catch(() => false)) {
      await b.click();
      if (HEB_DEBUG_API) console.log(`[HEB] Clic en botón sufijo índice ${i} (X) del mat-autocomplete`);
      return true;
    }
  }

  for (let i = 0; i < n; i++) {
    try {
      await suffixButtons.nth(i).click({ force: true, timeout: 2_000 });
      if (HEB_DEBUG_API) console.log(`[HEB] Clic forzado en botón sufijo índice ${i} (X)`);
      return true;
    } catch {
      // sigue
    }
  }

  // A veces el icon-button está en el form-field sin el wrapper .text-field-suffix
  const iconBtns = field.locator('button.mat-mdc-icon-button, button[mat-icon-button]');
  const ni = await iconBtns.count();
  for (let i = 0; i < ni; i++) {
    const b = iconBtns.nth(i);
    if (await b.isVisible().catch(() => false)) {
      await b.click();
      if (HEB_DEBUG_API) console.log('[HEB] Clic en mat-icon-button del mat-form-field (autocomplete)');
      return true;
    }
  }
  for (let i = 0; i < ni; i++) {
    try {
      await iconBtns.nth(i).click({ force: true, timeout: 1_500 });
      if (HEB_DEBUG_API) console.log('[HEB] Clic forzado en mat-icon-button del form-field');
      return true;
    } catch {
      // sigue
    }
  }

  const byRole = field.getByRole('button', { name: /clear|borrar|limpiar|close/i });
  if ((await byRole.count()) > 0) {
    const br = byRole.first();
    if (await br.isVisible().catch(() => false)) {
      await br.click();
      if (HEB_DEBUG_API) console.log('[HEB] Clic en botón sufijo por getByRole (Clear/Borrar)');
      return true;
    }
  }

  return false;
}

/**
 * Abre el mat-autocomplete: primero el clic en X del HEB, luego vacío, ArrowDown y scroll en virtual list.
 * @param {import('playwright').Page} page
 * @param {import('playwright').Locator} inputLoc
 */
async function hebMatAutocompleteEnsureOpenWithOptions(page, inputLoc) {
  const scrollPanels = page.locator(
    'cdk-overlay-container cdk-virtual-scroll-viewport, cdk-overlay-container .mat-mdc-autocomplete-panel, cdk-overlay-container .mdc-list'
  );

  await inputLoc.scrollIntoViewIfNeeded();
  await inputLoc.click();
  await page.waitForTimeout(80);

  // 1) Comportamiento comprobado en HEB: la "X" del sufijo abre / relanza el panel con toda la lista
  if (await hebClickMatSuffixClearForAutocomplete(inputLoc)) {
    await page.waitForTimeout(700);
    if ((await hebCountOverlayOptions(page)) > 0) {
      if (HEB_DEBUG_API) console.log('[HEB] Panel autocomplete abierto vía botón X');
      return;
    }
    await hebClickMatSuffixClearForAutocomplete(inputLoc).catch(() => false);
    await page.waitForTimeout(450);
    if ((await hebCountOverlayOptions(page)) > 0) return;
  }

  await inputLoc.fill('');
  await page.waitForTimeout(100);

  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < 8; i++) {
      await inputLoc.press('ArrowDown');
      await page.waitForTimeout(40);
      if ((await hebCountOverlayOptions(page)) > 0) return;
    }
    // Evitar Space: en algunos MDC elige la primera fila aunque no veamos aún nuestro código.
    await inputLoc.click();
    await page.waitForTimeout(150);
  }

  const nScroll = await scrollPanels.count();
  for (let s = 0; s < nScroll; s++) {
    for (let step = 0; step < 18; step++) {
      await scrollPanels
        .nth(s)
        .evaluate((el) => {
          el.scrollTop = (el.scrollTop || 0) + 400;
        })
        .catch(() => {});
      await page.waitForTimeout(70);
      if ((await hebCountOverlayOptions(page)) > 0) return;
    }
  }
}

async function hebClickMatOptionInDomByCode(page, c) {
  return page.evaluate((code) => {
    const esc = String(code).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${esc}\\b`, 'i');
    const all = document.querySelectorAll('mat-option, mat-mdc-option, [role=option]');
    for (const el of all) {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t || !re.test(t)) continue;
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      el.click();
      return true;
    }
    return false;
  }, c);
}

/**
 * Régimen / USO CFDI: mat-autocomplete. Sin filtrar con texto (puede esconder todo).
 * Estrategia: abrir con varias teclas, virtual scroll, getByRole, click forzado, fuzzy y hebClickOptionByCodeInPanel.
 */
async function hebSelectMatAutocomplete(page, inputLoc, code, fileTag, cap = {}) {
  const c = String(code).trim();
  if (!c) throw new Error(`HEB ${fileTag} vacío`);

  const textHint = hebCatalogTextHint(/** @type {Record<string, unknown>} */ (cap), fileTag, c);
  const reWord = new RegExp(`\\b${escapeRegExp(c)}\\b`, 'i');

  await hebMatAutocompleteEnsureOpenWithOptions(page, inputLoc);

  const inOverlay = page.locator('cdk-overlay-container');
  const byRole = inOverlay.getByRole('option', { name: reWord });
  if ((await byRole.count()) > 0) {
    try {
      await byRole.first().click({ timeout: 6_000 });
      console.log(`[HEB] ${fileTag} OK (getByRole): ${c}`);
      await page.waitForTimeout(250);
      return;
    } catch {
      // sigue
    }
  }

  const opts = hebAutocompleteOptions(page).filter({ hasText: reWord });
  try {
    await opts.first().waitFor({ state: 'attached', timeout: 4_000 });
    await opts.first().click({ force: true, timeout: 4_000 });
    console.log(`[HEB] ${fileTag} OK (click): ${c}`);
    await page.waitForTimeout(250);
    return;
  } catch {
    // sigue
  }

  if (textHint && (await hebClickMatOptionFuzzyInDom(page, c, textHint))) {
    console.log(`[HEB] ${fileTag} OK (fuzzy DOM): ${c}`);
    await page.waitForTimeout(250);
    return;
  }

  if (await hebClickOptionByCodeInPanel(page, inputLoc, c, fileTag, { openUnfiltered: true, fuzzyHint: textHint })) {
    return;
  }

  if (await hebClickMatOptionInDomByCode(page, c)) {
    console.log(`[HEB] ${fileTag} OK (DOM byCode): ${c}`);
    await page.waitForTimeout(250);
    return;
  }

  const nOpt = await hebCountOverlayOptions(page);
  const panelInfo = await page.evaluate(() => {
    const root = document.querySelector('cdk-overlay-container');
    if (!root) return 'sin_cdk_overlay';
    const p =
      document.querySelector('cdk-overlay-container .mat-mdc-autocomplete-panel') ||
      document.querySelector('cdk-overlay-container .mat-autocomplete-panel') ||
      document.querySelector('cdk-overlay-container [role="listbox"]');
    if (!p) {
      return `cdk_hijos=${root.children.length} sin_panel_ni_listbox`;
    }
    const o = document.querySelectorAll(
      'cdk-overlay-container mat-mdc-option, cdk-overlay-container mat-option, cdk-overlay-container [role=option]'
    );
    return `panel_h=${(/** @type {HTMLElement} */ (p).clientHeight)} opt_nodes=${o.length}`;
  });

  await hebFiscalDebugScreenshots(page, inputLoc, fileTag);
  throw new Error(
    `HEB no pudo elegir ${fileTag} ${c}. opciones_overlay≈${nOpt} ${panelInfo} Revisa heb_fiscal_${fileTag}_*.png en ${HEB_SCREENSHOT_DIR}`
  );
}

async function _generarFacturaHEB(ticketData, userData) {
  const { sucursal, noTicket, fecha, total } = ticketData;
  const { rfc, nombre: razonSocial, cp, regimen: regimenFiscal, email, usoCfdi = 'G03' } = userData;

  if (!sucursal || !noTicket || !fecha || total === undefined) {
    throw new Error('HEB faltan datos del ticket');
  }

  const fechaNorm = normalizarFecha(fecha);
  const [anio, mes, dia] = fechaNorm.split('-');

  const headless = playwrightUseHeadless(process.env.HEB_HEADFUL, '[HEB]', 'HEB_HEADFUL');
  const browser = await chromium.launch({ headless, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    locale: 'es-MX',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  let documentWait;
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
        if (url.includes('regimen_fiscal') && res.request().method() === 'GET' && res.status() === 200) {
          const j = await res.json();
          if (j) {
            captured.regimenFiscalJson = j;
            if (HEB_DEBUG_API) {
              const rows = hebRowsFromCatalogJson(j);
              console.log(`[HEB] intercept regimen_fiscal n=${rows.length} keysTop=${Object.keys(j).slice(0, 6).join(',')}`);
            }
          }
        }
        if (url.includes('uso_cfdi_sel') && res.request().method() === 'GET' && res.status() === 200) {
          const j = await res.json();
          if (j) captured.usoCfdiJson = j;
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

    // Si el GET de catálogo ocurrió antes de rellenar, el listener puede no haberlo guardado: repetir con fetch (misma cookie).
    if (!captured.regimenFiscalJson) {
      try {
        const j = await page.evaluate(async () => {
          const r = await fetch(
            'https://facturacion.heb.com.mx/cli/api/consulta/regimen_fiscal',
            { credentials: 'include' }
          );
          if (!r.ok) return null;
          return r.json();
        });
        if (j) {
          captured.regimenFiscalJson = j;
          console.log('[HEB] regimen_fiscal reobtenido vía fetch en página');
        }
      } catch {
        // noop
      }
    }
    if (!captured.usoCfdiJson) {
      try {
        const j = await page.evaluate(async () => {
          const r = await fetch('https://facturacion.heb.com.mx/cli/api/consulta/uso_cfdi_sel', { credentials: 'include' });
          if (!r.ok) return null;
          return r.json();
        });
        if (j) {
          captured.usoCfdiJson = j;
          console.log('[HEB] uso_cfdi_sel reobtenido vía fetch en página');
        }
      } catch {
        // noop
      }
    }

    // ── Régimen / USO CFDI — mat-autocomplete (catálogo API + DOM si no hay mat-option)
    const inputRegimen = hebFiscalTaxAutocompleteInput(
      page,
      fi,
      /Régimen\s+fiscal|R[ée]gimen\s+fiscal|Regimen\s+fiscal|Régimen/i,
      3
    );
    const inputUsoCfdi = hebFiscalTaxAutocompleteInput(
      page,
      fi,
      /Uso de CFDI|Uso de cfdi|Uso de Cfdi|USO DE CFDI|Uso.*CFD/i,
      5
    );
    await hebSelectMatAutocomplete(page, inputRegimen, String(regimenFiscal), 'regimen', captured);
    console.log('[HEB] Régimen:', regimenFiscal);

    await fi.nth(4).fill(email);
    console.log('[HEB] Email:', email);

    await hebSelectMatAutocomplete(page, inputUsoCfdi, String(usoCfdi), 'uso_cfdi', captured);
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

    // ── 10. Timbrar + documento: escuchar ambos ANTES del click (otra request con XML justo al timbrar)
    documentWait = startHebDocumentoWait(page, 90_000);
    const timbrarPromise = waitForHebTimbradoResponse(page, API_WAIT_MS);

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

    // ── 11. Documento (XML/PDF) — en el JSON de timbrado o en request aparte
    const d0 = captured.timbrado?.list_facturas?.[0]?.document;
    if (d0?.xml && d0?.pdf) {
      documentWait.abort();
      captured.docData = { list_facturas: captured.timbrado.list_facturas };
    } else {
      try {
        const docJ = await documentWait.promise;
        if (docJ) {
          captured.docData = docJ;
        } else {
          await page.screenshot({ path: hebScreenshotPath('heb_step6b_nodoc.png') });
          throw new Error('HEB: sin documento (XML) tras el timbrado. HEB_DEBUG_API=1');
        }
      } catch (e) {
        await page.screenshot({ path: hebScreenshotPath('heb_step6b_nodoc.png') });
        throw e;
      }
    }
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
    try {
      if (documentWait) documentWait.abort();
    } catch {
      // noop
    }
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
