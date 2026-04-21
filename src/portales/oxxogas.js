// src/portales/oxxogas.js
// Adaptador Playwright para OXXO Gas
// Sesión persistente — login manual una vez con save-session.js

const { chromium, firefox } = require('playwright');
const fs = require('fs');
const path = require('path');
const { resolveDataDir } = require('../dataDir');
const {
  getPlaywrightProxyOxxoGas,
  playwrightBrowserForOxxoGasProxy,
} = require('../proxyAgent');

const PORTAL_URL = 'https://facturacion.oxxogas.com';
const DATA_DIR = resolveDataDir();
const SESSION_FILE = path.join(DATA_DIR, 'oxxogas-session.json');

/** networkidle falla en muchos portales (tráfico continuo); load + timeout largo para Railway / proxy. */
const GOTO = { waitUntil: 'load', timeout: 120_000 };

async function facturarOxxoGas({ estacion, noTicket, monto, userData, esEfectivo = false, outputDir }) {
  if (!fs.existsSync(SESSION_FILE)) {
    return { ok: false, error: 'No hay sesión guardada. Corre: node save-session.js' };
  }

  // Sin OXXOGAS_USE_PLAYWRIGHT_PROXY: directo. Con 1: OXXOGAS_PROXY_URL → SOCKS5 → HTTP sticky (ver proxyAgent).
  const proxy = getPlaywrightProxyOxxoGas();
  const browserName = playwrightBrowserForOxxoGasProxy(proxy);
  console.log(
    '[OxxoGas] Playwright proxy:',
    proxy ? `on (${proxy.server}) browser=${browserName}` : `off (directo) browser=${browserName}`
  );
  const launchBase = {
    headless: true,
    ...(proxy ? { proxy } : {}),
  };
  const browser =
    browserName === 'firefox'
      ? await firefox.launch(launchBase)
      : await chromium.launch({
          ...launchBase,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        });
  const context = await browser.newContext({ storageState: SESSION_FILE });
  const page = await context.newPage();

  try {
    // 1. VERIFICAR SESIÓN
    console.log('[OxxoGas] Verificando sesión...');
    await page.goto(`${PORTAL_URL}/home`, GOTO);

    const afterUrl = page.url();
    console.log('[OxxoGas] URL tras /home:', afterUrl);

    const checkResult = await page.evaluate(async () => {
      try {
        const r = await fetch('/checkuser', { method: 'POST', credentials: 'include' });
        const text = await r.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          return { ok: false, status: r.status, parseError: true, snippet: text.slice(0, 300) };
        }
        const logged = data.is_logged === 'TRUE';
        return { ok: logged, status: r.status, is_logged: data.is_logged, keys: data && typeof data === 'object' ? Object.keys(data) : [] };
      } catch (e) {
        return { ok: false, err: String(e && e.message ? e.message : e).slice(0, 300) };
      }
    });

    console.log('[OxxoGas] checkuser:', JSON.stringify(checkResult));

    if (!checkResult.ok) {
      const hint =
        afterUrl.includes('login') || afterUrl.includes('inicio')
          ? 'redir_login'
          : 'checkuser_fallo';
      console.warn('[OxxoGas] checkuser no OK, hint=', hint);
      return {
        ok: false,
        error:
          'Sesión no válida en OXXO Gas (el portal no reconoce login). Si acabas de subir oxxogas-session.json, suele ser IP: la sesión se abrió desde tu red y el bot corre en otra (Railway). Opciones: proxy residencial MX con OXXOGAS_USE_PLAYWRIGHT_PROXY=1 y volver a guardar/subir sesión, o revisar en logs la línea [OxxoGas] checkuser.',
      };
    }
    console.log('[OxxoGas] Sesión activa ✅');

    // 2. REGISTRAR RFC SI NO EXISTE
    console.log(`[OxxoGas] Verificando RFC ${userData.rfc}...`);
    const usoCfdi = userData.usoCfdi || getUsoCfdi(userData.regimen);
    const rfcId = await registrarOObtenerRfc(page, userData, usoCfdi);
    console.log(`[OxxoGas] RFC ID: ${rfcId}`);

    // 3. NAVEGAR A FACTURAR
    await page.goto(`${PORTAL_URL}/facturacion/facturar`, GOTO);

    const estacionNorm = estacion.replace(/^E(\d+)$/, (_, n) => 'E' + n.padStart(5, '0'));

    // 4. AGREGAR TICKET
    console.log(`[OxxoGas] Ticket estacion=${estacionNorm} folio=${noTicket} monto=${monto}`);
    const ticketResp = await page.evaluate(async ({ estacion, noTicket, monto }) => {
      const r = await fetch('/facturacion/facturar/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `estacion=${estacion}&ticket=${noTicket}&monto=${parseFloat(monto).toFixed(2)}`
      });
      return r.json();
    }, { estacion: estacionNorm, noTicket, monto });

    if (!ticketResp.success) {
      throw new Error(`Error al agregar ticket: ${JSON.stringify(ticketResp)}`);
    }
    console.log('[OxxoGas] Ticket registrado ✅');

    // 5. OBTENER LISTA Y FORMA DE PAGO
    const listResp = await page.evaluate(async () => {
      const r = await fetch('/facturacion/facturar/getList', { method: 'POST' });
      return r.json();
    });

    if (!listResp.data || listResp.data.length === 0) {
      throw new Error('Ticket no aparece en la lista — verifica estación, folio y monto');
    }

    const t = listResp.data[0];
    console.log(`[OxxoGas] Ticket en lista: estacion=${t.estacion_id} folio=${t.folio} monto=${t.monto}`);

    let ticketFinal = t;
    if (!t.TicketOfUserId) {
      console.log('[OxxoGas] TicketOfUserId vacío — esperando...');
      await page.waitForTimeout(3000);
      const listResp2 = await page.evaluate(async () => {
        const r = await fetch('/facturacion/facturar/getList', { method: 'POST' });
        return r.json();
      });
      if (listResp2.data && listResp2.data.length > 0) {
        ticketFinal = listResp2.data[0];
      }
    }

    let formasDePago = [];
    try { formasDePago = JSON.parse(ticketFinal.tipodepago); } catch (e) {}

    let formaPago;
    if (esEfectivo) {
      formaPago = formasDePago.find(f => f.FormaDePagoSeleccionableCve === 'EFECTIVO');
    } else {
      formaPago = formasDePago.find(f =>
        f.FormaDePagoSeleccionableCve === 'CREDITO' ||
        f.FormaDePagoSeleccionableCve === 'DEBITO'
      );
    }
    formaPago = formaPago || formasDePago[0];

    if (formaPago) {
      const tipodepago = [
        formaPago.FormaDePagoSeleccionableCve,
        ticketFinal.estacion,
        ticketFinal.estacion_id,
        ticketFinal.folio,
        ticketFinal.monto,
        ticketFinal.TicketOfUserId || ''
      ].join('+');

      await page.evaluate(async (tipodepago) => {
        await fetch('/facturacion/facturar/changeTicketValue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `tipodepago=${encodeURIComponent(tipodepago)}`
        });
      }, tipodepago);
      console.log(`[OxxoGas] Forma de pago: ${formaPago.FormaDePagoSeleccionableCve}`);
    }

    // 6. GENERAR CFDI
    console.log('[OxxoGas] Generando CFDI...');
    const facturaResp = await page.evaluate(async ({ rfcId, regimen, usoCfdi }) => {
      const r = await fetch('/facturacion/facturar/factura', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `isCFDI4=true&rfc=${rfcId}&regimen_fiscal=${regimen}&usocfdi=${usoCfdi}`
      });
      return r.json();
    }, { rfcId, regimen: userData.regimen, usoCfdi });

    if (facturaResp.success) {
      console.log(`[OxxoGas] ✅ ${facturaResp.success}`);

      let xmlPath = null;
      let pdfPath = null;

      try {
        const facturasResp = await page.evaluate(async () => {
          const r = await fetch('/facturacion/facturas/getList', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'month=0&year=0'
          });
          return r.json();
        });

        const ultimaFactura = facturasResp.data && facturasResp.data[0];
        if (ultimaFactura && ultimaFactura.folio) {
          const partes = ultimaFactura.folio.split('|');
          const uuid = partes[1] ? partes[1].trim() : null;
          const folioNum = partes[0] ? partes[0].trim() : 'factura';

          if (uuid) {
            console.log(`[OxxoGas] Descargando UUID: ${uuid}`);
            fs.mkdirSync(outputDir, { recursive: true });

            const xmlBuffer = await page.evaluate(async (uuid) => {
              const r = await fetch(`/facturacion/facturas/xml/${uuid}`);
              const buf = await r.arrayBuffer();
              return Array.from(new Uint8Array(buf));
            }, uuid);
            xmlPath = path.join(outputDir, `${folioNum}.xml`);
            fs.writeFileSync(xmlPath, Buffer.from(xmlBuffer));
            console.log(`[OxxoGas] XML guardado: ${xmlPath}`);

            const pdfBuffer = await page.evaluate(async (uuid) => {
              const r = await fetch(`/facturacion/facturas/pdf/${uuid}`);
              const buf = await r.arrayBuffer();
              return Array.from(new Uint8Array(buf));
            }, uuid);
            pdfPath = path.join(outputDir, `${folioNum}.pdf`);
            fs.writeFileSync(pdfPath, Buffer.from(pdfBuffer));
            console.log(`[OxxoGas] PDF guardado: ${pdfPath}`);
          }
        }
      } catch (err) {
        console.error('[OxxoGas] Error descargando archivos:', err.message);
      }

      return { ok: true, xmlPath, pdfPath, envioPorCorreo: !xmlPath && !pdfPath, message: facturaResp.success };
    } else {
      throw new Error(`Error al generar CFDI: ${JSON.stringify(facturaResp)}`);
    }

  } catch (err) {
    console.error('[OxxoGas] ❌', err.message);
    return { ok: false, error: err.message };
  } finally {
    await browser.close();
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

async function registrarOObtenerRfc(page, userData, usoCfdi) {
  const listResp = await page.evaluate(async () => {
    const r = await fetch('/sistema/fiscales/getList', { method: 'POST' });
    return r.json();
  });

  const rfcUpper = userData.rfc.toUpperCase();
  const existente = (listResp.data || []).find(r => r.rfc === rfcUpper);

  if (existente) {
    const id = existente.id || existente.rfc_id || existente.fiscal_id || existente.cliente_id;
    if (id) { console.log(`[OxxoGas] RFC ya existe ID=${id}`); return id; }
    const rfcData = await page.evaluate(async (rfc) => {
      const r = await fetch('/facturacion/facturar/getRfc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `isCFDI4=true&rfc=${rfc}`
      });
      return r.json();
    }, rfcUpper);
    if (rfcData && rfcData.rfc_nombre) return rfcUpper;
  }

  console.log(`[OxxoGas] Registrando nuevo RFC ${userData.rfc}...`);
  const coloniaResp = await page.evaluate(async (cp) => {
    const r = await fetch(`/sistema/fiscales/codigopostal/${cp}`, { method: 'POST' });
    return r.json();
  }, userData.cp);

  if (!coloniaResp.loc_id) throw new Error(`CP ${userData.cp} no encontrado en portal OXXO Gas`);

  const body = new URLSearchParams({
    isCFDI4: 'true', regimen: '1', regimen_fiscal: String(userData.regimen),
    usocfdi: usoCfdi, razonsocial: userData.nombre,
    estado: String(coloniaResp.est_id), municipio: String(coloniaResp.mun_clave),
    colonia: String(coloniaResp.loc_id), cp: String(userData.cp),
    calle: userData.calle || 'SIN CALLE', noext: userData.noext || 'S/N',
    noint: '', email: userData.email, rfc: userData.rfc.toUpperCase()
  }).toString();

  const agregarResp = await page.evaluate(async (body) => {
    const r = await fetch('/sistema/fiscales/agregar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
    });
    return r.json();
  }, body);

  if (!agregarResp.success && agregarResp.msg !== null) {
    throw new Error(`Error registrando RFC: ${JSON.stringify(agregarResp)}`);
  }

  const listResp2 = await page.evaluate(async () => {
    const r = await fetch('/sistema/fiscales/getList', { method: 'POST' });
    return r.json();
  });

  const nuevo = (listResp2.data || []).find(r => r.rfc === rfcUpper);
  if (!nuevo) throw new Error(`RFC ${userData.rfc} no aparece en la lista tras registrarlo`);
  const nuevoId = nuevo.id || nuevo.rfc_id || nuevo.fiscal_id || nuevo.cliente_id || rfcUpper;
  console.log(`[OxxoGas] RFC listo ID=${nuevoId}`);
  return nuevoId;
}

function getUsoCfdi(regimen) {
  return { '605': 'S01', '612': 'G03', '626': 'G03' }[String(regimen)] || 'G03';
}

module.exports = { facturarOxxoGas };
