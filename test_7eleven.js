/**
 * test_7eleven.js — Phase 2 Diagnostic Script
 * 
 * Corre con: node test_7eleven.js
 * Requisitos: playwright, axios, dotenv (ya en el proyecto)
 * 
 * Modo: headless:false (browser visible)
 * Screenshots después de cada acción en ./screenshots/
 * Captcha resuelto con Claude Vision (Haiku) — usa ANTHROPIC_API_KEY del .env
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

require('dotenv').config();

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_KEY) {
  console.error('❌ Falta ANTHROPIC_API_KEY en .env');
  process.exit(1);
}

// ============================================================
// CONFIG — Cambiar para cada prueba
// ============================================================
const CONFIG = {
  noTicket: '14601404202621000072843500332981657',
  rfc: 'SEGC9001195V8',
  razon: 'CARLOS ALBERTO SERNA GAMEZ',
  cp: '66220',
  regimenFiscal: '612',
  usoCFDI: 'G03',
  email: 'sernagamez@gmail.com',
};

const PORTAL_URL = 'https://www.e7-eleven.com.mx/facturacion/KPortalExterno/';
const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');

// ============================================================
// CLAUDE VISION — Resolver captcha con Haiku
// ============================================================
async function solveCaptchaWithVision(base64Img) {
  console.log('  🧠 Enviando captcha a Claude Vision (Haiku)...');
  const resp = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 50,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64Img } },
        { type: 'text', text: 'Lee el texto del captcha en esta imagen. Responde SOLO con los caracteres exactos, sin explicación, sin comillas, sin espacios.' },
      ],
    }],
  }, {
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
  });
  const text = resp.data.content[0].text.trim();
  console.log(`  ✅ Vision respondió: "${text}"`);
  return text;
}

// ============================================================
// HELPERS
// ============================================================
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

let stepCount = 0;
async function snap(page, label) {
  stepCount++;
  const file = `${String(stepCount).padStart(2, '0')}_${label}.png`;
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, file), fullPage: true });
  console.log(`  📸 ${file}`);
}

function log(msg) {
  console.log(`\n${'='.repeat(60)}\n[PASO ${stepCount + 1}] ${msg}\n${'='.repeat(60)}`);
}

// ============================================================
// MAIN
// ============================================================
async function run() {
  ensureDir(SCREENSHOTS_DIR);
  
  console.log('\n🚀 test_7eleven.js — Diagnóstico Portal 7-Eleven');
  console.log(`   Ticket: ${CONFIG.noTicket}`);
  console.log(`   RFC:    ${CONFIG.rfc}\n`);

  const browser = await chromium.launch({ headless: false, slowMo: 500 });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

  // ─── Interceptar requests captcha + API ───
  const captchaUrls = [];
  context.on('request', req => {
    const url = req.url();
    if (/kaptcha|captcha/i.test(url)) {
      console.log(`  🔍 CAPTCHA req: ${req.method()} ${url}`);
      captchaUrls.push({ method: req.method(), url, type: req.resourceType() });
    }
    if (req.resourceType() === 'image' && !url.includes('data:image')) {
      console.log(`  🖼️  IMG: ${url}`);
    }
  });

  context.on('response', async resp => {
    const url = resp.url();
    if (url.includes('/KJServices/') || url.includes('/kaptcha')) {
      let body = '';
      try { body = (await resp.text()).substring(0, 300); } catch {}
      console.log(`  📡 ${resp.status()} ${url.split('?')[0]}`);
      if (body && !body.startsWith('JVBERi')) console.log(`      ${body}`);
    }
  });

  const page = await context.newPage();

  try {
    // ── 1. Cargar portal ──
    log('Cargando portal');
    await page.goto(PORTAL_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await snap(page, 'portal');

    // ── 2. Click Factura Express ──
    log('Factura Express');
    const allBtns = await page.$$eval('button, a, [ng-click], [md-button]', els => 
      els.map(el => ({
        tag: el.tagName, text: el.textContent?.trim().substring(0, 60),
        ngClick: el.getAttribute('ng-click'),
      })).filter(b => b.text)
    );
    console.log('  Botones:');
    allBtns.forEach(b => console.log(`    [${b.tag}] "${b.text}" ng-click=${b.ngClick || '-'}`));

    const fxBtn = await page.$('text=Factura Express') 
      || await page.$('text=FACTURA EXPRESS')
      || await page.$('[ng-click*="xpress"]');
    if (fxBtn) {
      await fxBtn.click();
      console.log('  ✅ Click');
      await page.waitForTimeout(2000);
    }
    await snap(page, 'fx_click');

    // ── 3. Dump todos los inputs ──
    log('Inspección de formulario');
    const allInputs = await page.$$eval('input, select, textarea, md-select', els =>
      els.map(el => ({
        tag: el.tagName, type: el.type || '', id: el.id || '',
        ngModel: el.getAttribute('ng-model') || '',
        placeholder: el.placeholder || '',
        vis: el.offsetParent !== null,
      }))
    );
    console.log('  Inputs encontrados:');
    allInputs.forEach(i => {
      console.log(`    <${i.tag}> type=${i.type} id="${i.id}" ng-model="${i.ngModel}" ph="${i.placeholder}" vis=${i.vis}`);
    });

    // ── 4. Dump imágenes (buscar captcha) ──
    log('Buscando captcha img');
    const allImgs = await page.$$eval('img', imgs =>
      imgs.map(i => ({ src: i.src, id: i.id, w: i.naturalWidth, h: i.naturalHeight }))
    );
    console.log('  Imágenes:');
    allImgs.forEach(i => console.log(`    src="${i.src}" id="${i.id}" ${i.w}x${i.h}`));

    let captchaEl = await page.$('img[src*="kaptcha"]')
      || await page.$('img[src*="captcha"]')
      || await page.$('img[id*="aptcha"]')
      || await page.$('img[id*="Kaptcha"]');
    
    if (captchaEl) {
      console.log(`  ✅ Captcha img encontrada: ${await captchaEl.getAttribute('src')}`);
    } else {
      console.log('  ⚠️ No <img> de captcha — urls interceptadas:', captchaUrls.length);
    }
    await snap(page, 'form');

    // ── 5. Ingresar ticket ──
    log('Ticket');
    const ticketEl = await page.$('input[ng-model*="icket"]')
      || await page.$('input[placeholder*="icket" i]')
      || await page.$('input[placeholder*="código" i]');
    if (ticketEl) {
      await ticketEl.fill(CONFIG.noTicket);
      console.log('  ✅ Ticket escrito');
      
      const addBtn = await page.$('text=Agregar Ticket')
        || await page.$('text=Agregar') || await page.$('button[ng-click*="gregar"]');
      if (addBtn) {
        await addBtn.click();
        console.log('  ✅ Agregar click');
        await page.waitForTimeout(3000);
      }
      await snap(page, 'ticket');
    } else {
      console.log('  ❌ Input ticket no encontrado');
    }

    // ── 6. Datos fiscales ──
    log('Datos fiscales');
    
    const fill = async (sels, val, lbl) => {
      for (const s of sels) {
        const el = await page.$(s);
        if (el) { await el.fill(val); console.log(`  ✅ ${lbl}`); return el; }
      }
      console.log(`  ⚠️ ${lbl} no encontrado`);
      return null;
    };

    const rfcEl = await fill(['input[ng-model*="rfc" i]', 'input[placeholder*="RFC"]'], CONFIG.rfc, 'RFC');
    if (rfcEl) { await rfcEl.press('Tab'); await page.waitForTimeout(1000); }

    await fill(['input[ng-model*="razon" i]', 'input[ng-model*="ombre" i]', 'input[placeholder*="azón" i]'], CONFIG.razon, 'Razón');
    await fill(['input[ng-model*="cp" i]', 'input[ng-model*="ostal" i]', 'input[placeholder*="ostal" i]'], CONFIG.cp, 'CP');
    await fill(['input[ng-model*="mail" i]', 'input[type="email"]'], CONFIG.email, 'Email');

    // Dropdowns (md-select o select nativo)
    const pickOption = async (sels, val, lbl) => {
      for (const s of sels) {
        const el = await page.$(s);
        if (!el) continue;
        const tag = await el.evaluate(e => e.tagName.toLowerCase());
        if (tag === 'select') {
          await el.selectOption(val);
        } else {
          await el.click(); await page.waitForTimeout(500);
          const opt = await page.$(`md-option[value="${val}"]`);
          if (opt) await opt.click();
        }
        console.log(`  ✅ ${lbl}`);
        return;
      }
      console.log(`  ⚠️ ${lbl} no encontrado`);
    };

    await pickOption(['[ng-model*="egimen" i]'], CONFIG.regimenFiscal, 'Régimen');
    await pickOption(['[ng-model*="uso" i]', '[ng-model*="CFDI" i]'], CONFIG.usoCFDI, 'Uso CFDI');
    await snap(page, 'fiscal');

    // ── 7. Captcha ──
    log('Captcha → Claude Vision');
    await page.waitForTimeout(2000);

    // Re-buscar por si apareció después
    if (!captchaEl) {
      captchaEl = await page.$('img[src*="kaptcha"]')
        || await page.$('img[src*="captcha"]')
        || await page.$('img[id*="aptcha"]');
    }

    if (captchaEl) {
      await captchaEl.waitForElementState('stable');
      await page.waitForTimeout(1000);
      
      const buf = await captchaEl.screenshot();
      fs.writeFileSync(path.join(SCREENSHOTS_DIR, 'captcha_crop.png'), buf);
      console.log(`  📸 Captcha capturado (${buf.length} bytes)`);

      const solved = await solveCaptchaWithVision(buf.toString('base64'));

      // Buscar input del captcha
      const capInput = await page.$('input[ng-model*="aptcha" i]')
        || await page.$('input[placeholder*="aptcha" i]')
        || await page.$('input[placeholder*="imagen" i]');
      
      if (capInput) {
        await capInput.fill(solved);
        console.log(`  ✅ "${solved}" ingresado`);
      } else {
        console.log('  ⚠️ Input captcha no encontrado — inputs vacíos visibles:');
        const empties = await page.$$eval('input[type="text"]', els =>
          els.filter(e => e.offsetParent && !e.value)
            .map(e => ({ id: e.id, ng: e.getAttribute('ng-model'), ph: e.placeholder }))
        );
        empties.forEach(e => console.log(`    id="${e.id}" ng="${e.ng}" ph="${e.ph}"`));
      }
    } else {
      console.log('  ⚠️ Sin imagen captcha — 30s pausa manual');
      await page.waitForTimeout(30000);
    }
    await snap(page, 'captcha');

    // ── 8. Botón Facturar (solo diagnóstico, NO click) ──
    log('Botón Facturar');
    const facBtn = await page.$('text=Facturar')
      || await page.$('text=FACTURAR')
      || await page.$('button[ng-click*="acturar" i]');
    console.log(facBtn ? '  ✅ Encontrado (NO click — evitar duplicado)' : '  ⚠️ No encontrado');
    await snap(page, 'final');

    // ── RESUMEN ──
    console.log('\n' + '='.repeat(60));
    console.log('📋 RESUMEN');
    console.log('='.repeat(60));
    console.log(`Captcha img:    ${captchaEl ? '✅' : '❌'}`);
    console.log(`Ticket input:   ${ticketEl ? '✅' : '❌'}`);
    console.log(`RFC input:      ${rfcEl ? '✅' : '❌'}`);
    console.log(`Facturar btn:   ${facBtn ? '✅' : '❌'}`);
    console.log('\nCaptcha URLs interceptadas:');
    captchaUrls.forEach(u => console.log(`  ${u.method} ${u.url} (${u.type})`));
    console.log('='.repeat(60));

    console.log('\n⏸️  Browser abierto 5 min — inspecciona en DevTools');
    await page.waitForTimeout(300000);

  } catch (err) {
    console.error(`\n❌ ${err.message}`);
    await snap(page, 'error');
    await page.waitForTimeout(120000);
  } finally {
    await browser.close();
    console.log('\n🏁 Fin. Screenshots en ./screenshots/');
  }
}

run().catch(console.error);
