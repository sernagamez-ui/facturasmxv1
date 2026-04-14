/**
 * diagnostico-petro7.js v2
 * Corre: node diagnostico-petro7.js
 * Guarda screenshots en ~/Desktop/petro7-debug/
 */

require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

const DIR = path.join(os.homedir(), 'Desktop', 'petro7-debug');
fs.mkdirSync(DIR, { recursive: true });
console.log('📁 Guardando en:', DIR);

const BASE_URL = 'https://tarjetapetro-7.com.mx/KPortalExterno/';

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page    = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  });

  // ── 1. Cargar portal ─────────────────────────────────────────────
  console.log('\n[1] Cargando portal...');
  await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(DIR, '01_home.png'), fullPage: true });
  console.log('✅ 01_home guardado');

  // ── 2. Click en FACTURA EXPRESS ──────────────────────────────────
  console.log('\n[2] Click en FACTURA EXPRESS...');
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('[ng-click]'))
      .find(e => (e.getAttribute('ng-click') || '').includes('setSelected(1)'));
    if (el) el.click();
  });
  await page.waitForTimeout(5000);
  await page.screenshot({ path: path.join(DIR, '02_post_express.png'), fullPage: true });
  console.log('✅ 02_post_express guardado');

  // ── 3. Inspeccionar todos los inputs y imágenes ──────────────────
  const info = await page.evaluate(() => {
    return {
      inputsVisibles: Array.from(document.querySelectorAll('input'))
        .filter(el => el.offsetWidth > 0)
        .map(el => ({ id: el.id, name: el.name, type: el.type, ngModel: el.getAttribute('ng-model'), placeholder: el.placeholder })),

      todasLasImgs: Array.from(document.querySelectorAll('img'))
        .map(el => ({ id: el.id, src: el.src.substring(0,100), alt: el.alt, w: el.offsetWidth, h: el.offsetHeight, visible: el.offsetWidth > 0 })),

      botonesVisibles: Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"]'))
        .filter(el => el.offsetWidth > 0)
        .map(el => ({ value: el.value, text: el.textContent.trim(), ngClick: el.getAttribute('ng-click'), ngIf: el.getAttribute('ng-if') })),

      botonesOcultos: Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"]'))
        .filter(el => el.offsetWidth === 0)
        .map(el => ({ value: el.value, text: el.textContent.trim(), ngClick: el.getAttribute('ng-click'), ngIf: el.getAttribute('ng-if') })),
    };
  });

  console.log('\n📋 INPUTS VISIBLES:');
  info.inputsVisibles.forEach((el,i) => console.log(`  [${i}] id="${el.id}" name="${el.name}" ng-model="${el.ngModel}" placeholder="${el.placeholder}" type="${el.type}"`));

  console.log('\n📋 TODAS LAS IMÁGENES:');
  info.todasLasImgs.forEach((el,i) => console.log(`  [${i}] id="${el.id}" alt="${el.alt}" ${el.w}x${el.h} src="${el.src}" visible=${el.visible}`));

  console.log('\n📋 BOTONES VISIBLES:');
  info.botonesVisibles.forEach((el,i) => console.log(`  [${i}] value="${el.value}" text="${el.text}" ng-click="${el.ngClick}" ng-if="${el.ngIf}"`));

  console.log('\n📋 BOTONES OCULTOS (ng-if):');
  info.botonesOcultos.filter(b => b.ngIf).forEach((el,i) => console.log(`  [${i}] value="${el.value}" ng-click="${el.ngClick}" ng-if="${el.ngIf}"`));

  // ── 4. Llenar datos y ver qué pasa con el captcha ────────────────
  console.log('\n[4] Llenando datos del ticket...');
  await page.evaluate(({ t }) => {
    const set = (name, val) => {
      const el = document.querySelector(`input[name="${name}"], [ng-model="${name}"]`);
      if (!el) return;
      el.value = val;
      if (window.angular) {
        const s = window.angular.element(el).scope();
        if (s) {
          const m = el.getAttribute('ng-model');
          if (m) {
            const p = m.split('.');
            let o = s;
            for (let i=0; i<p.length-1; i++) { if(!o[p[i]]) o[p[i]]={}; o=o[p[i]]; }
            o[p[p.length-1]] = val;
          }
          s.$apply();
        }
      }
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set('noEstacion', t.estacion);
    set('noTicket',   t.folio);
    set('wid',        t.wid);
    set('rfcCliente', t.rfc);
    set('razon',      t.nombre);
    set('cp',         t.cp);
    set('emailInput', t.email);
  }, { t: {
    estacion: '1234',           // ← número de estación del ticket
    folio:    '2491872',        // ← folio del ticket
    wid:      'D056',           // ← Web ID del ticket
    rfc:      'XAXX010101000',  // ← RFC real
    nombre:   'TEST USUARIO',
    cp:       '64000',
    email:    'test@test.com',
  }});

  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(DIR, '03_datos_llenos.png'), fullPage: true });
  console.log('✅ 03_datos_llenos guardado');

  // Ver estado del captcha después de llenar
  const captchaInfo = await page.evaluate(() => {
    const inputCaptcha = document.querySelector('#captcha, [name="captcha"], [ng-model="captcha"]');
    const parent = inputCaptcha?.closest('div, td, tr') || inputCaptcha?.parentElement;
    const imgEnParent = parent?.querySelector('img');
    const todasVisible = Array.from(document.querySelectorAll('img')).filter(i => i.offsetWidth > 0);
    return {
      captchaInputVisible: inputCaptcha ? (inputCaptcha.offsetWidth > 0) : false,
      captchaInputValue:   inputCaptcha?.value,
      imgEnParentDelCaptcha: imgEnParent ? { id: imgEnParent.id, src: imgEnParent.src.substring(0,100), alt: imgEnParent.alt, w: imgEnParent.offsetWidth, h: imgEnParent.offsetHeight } : null,
      imagenesVisibles: todasVisible.map(i => ({ id: i.id, src: i.src.substring(0,80), alt: i.alt, w: i.offsetWidth, h: i.offsetHeight })),
      botonesVisiblesAhora: Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"]'))
        .filter(el => el.offsetWidth > 0)
        .map(el => ({ value: el.value, text: el.textContent.trim(), ngClick: el.getAttribute('ng-click'), ngIf: el.getAttribute('ng-if') })),
    };
  });

  console.log('\n📋 ESTADO DEL CAPTCHA después de llenar datos:');
  console.log('  captchaInput visible:', captchaInfo.captchaInputVisible);
  console.log('  captchaInput value:', captchaInfo.captchaInputValue);
  console.log('  Imagen en parent del captcha:', captchaInfo.imgEnParentDelCaptcha);
  console.log('  Todas las imágenes visibles:', captchaInfo.imagenesVisibles);
  console.log('\n📋 BOTONES VISIBLES ahora:');
  captchaInfo.botonesVisiblesAhora.forEach((b,i) => console.log(`  [${i}] value="${b.value}" text="${b.text}" ng-click="${b.ngClick}" ng-if="${b.ngIf}"`));

  console.log('\n✅ Listo. Archivos en:', DIR);
  console.log('👀 El browser está abierto — inspecciona manualmente y ciérralo con Ctrl+C\n');
  await page.waitForTimeout(120000);
  await browser.close();
})();
