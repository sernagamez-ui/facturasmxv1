// src/portales/alsea.js
// Adaptador HTTP para Alsea/Interfactura — axios, sin Playwright, sin CAPTCHA
// Un solo módulo cubre 14+ marcas: Starbucks, Domino's, Burger King, Chili's,
// CPK, P.F. Chang's, Italianni's, VIPS, Popeyes, Cheesecake Factory, etc.
// API REST JSON descubierta via HAR — cero ViewState, cero sesión.

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const API_BASE = 'https://alsea.interfactura.com/api/chatbot';

const HEADERS = {
  'Content-Type':  'application/json',
  'Origin':        'https://alsea.interfactura.com',
  'Cache-Control': 'no-cache',
  'Pragma':        'no-cache',
  'User-Agent':    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
};

// Marcas fast-food → isFastFood: true en el payload
const FAST_FOOD = new Set([
  'Starbucks', 'Dominos', 'BurgerKing', 'CPK', 'PeiWei', 'Popeyes',
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatearFecha(fechaStr) {
  // 'YYYY-MM-DD' → 'YYYY-MM-DDT06:00:00.000Z' (UTC-6 = medianoche MX)
  let yyyy, mm, dd;
  if (fechaStr.includes('/')) {
    [dd, mm, yyyy] = fechaStr.split('/');
  } else {
    [yyyy, mm, dd] = fechaStr.split('-');
  }
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T06:00:00.000Z`;
}

/**
 * Separa nombre completo en nombres/apellidos para la API.
 * Persona MORAL: todo va en `nombres`, `apellidos` vacío.
 * Persona FÍSICA: últimas 2 palabras = apellidos, resto = nombres.
 */
function splitNombre(nombreCompleto, rfc) {
  const esMoral = rfc.length === 12;
  if (esMoral) {
    return { nombres: nombreCompleto.toUpperCase(), apellidos: '' };
  }

  const partes = nombreCompleto.trim().toUpperCase().split(/\s+/);
  if (partes.length <= 2) {
    return { nombres: partes[0] || '', apellidos: partes.slice(1).join(' ') };
  }
  // ≥3 palabras: últimas 2 son apellidos (patrón mexicano estándar)
  const apellidos = partes.slice(-2).join(' ');
  const nombres   = partes.slice(0, -2).join(' ');
  return { nombres, apellidos };
}

function buildPayload(ticketData, userData, incluirFiscal) {
  const payload = {
    rfc:                userData.rfc.toUpperCase(),
    ticket:             String(ticketData.noTicket),
    nombres:            '',
    apellidos:          '',
    usoCfdi:            '',
    correoElectronico:  '',
    tienda:             String(ticketData.tienda),
    fecha:              formatearFecha(ticketData.fecha),
    operador:           ticketData.operador,
    isFastFood:         FAST_FOOD.has(ticketData.operador),
  };

  if (incluirFiscal) {
    const { nombres, apellidos } = splitNombre(userData.nombre, userData.rfc);
    payload.nombres            = nombres;
    payload.apellidos          = apellidos;
    payload.codigoPostal       = userData.cp;
    payload.regimenFiscal      = userData.regimen;
    payload.usoCfdi            = userData.usoCfdi || 'G03'; // Gastos en general (default restaurantes)
    payload.correoElectronico  = userData.email.toUpperCase();
    payload.persona            = userData.rfc.length === 12 ? 'MORAL' : 'FISICA';
    payload.residenciaFiscal   = '';
  }

  return payload;
}

/**
 * Extrae mensaje legible de exception.
 * La API devuelve excepciones C# serializadas como objeto JSON:
 * { ClassName: "System.Exception", Message: "...", Data: null, ... }
 */
function extractExceptionMsg(exc, fallback = '') {
  if (!exc) return fallback;
  if (typeof exc === 'string') return exc;
  if (typeof exc === 'object' && exc.Message) return exc.Message;
  return String(exc) || fallback;
}

async function postAPI(endpoint, payload) {
  const url = `${API_BASE}/${endpoint}`;
  const res = await axios.post(url, payload, {
    headers: {
      ...HEADERS,
      'Referer': `https://alsea.interfactura.com/wwwroot?opc=${payload.operador}`,
    },
    timeout: 30000,
  });
  return res.data;
}

function extractLinks(htmlResponse) {
  const links = [];
  const regex = /href='([^']+)'/g;
  let match;
  while ((match = regex.exec(htmlResponse)) !== null) {
    links.push(match[1]);
  }
  return links;
}

// ─── Descarga de archivos del Viewer ──────────────────────────────────────────

async function descargarArchivo(url, filepath) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    headers: { 'User-Agent': HEADERS['User-Agent'], 'Referer': 'https://alsea.interfactura.com/' },
    timeout: 30000,
  });

  const contentType = (res.headers['content-type'] || '').toLowerCase();
  fs.writeFileSync(filepath, res.data);

  return { contentType, size: res.data.length };
}

// ─── Orquestador ──────────────────────────────────────────────────────────────

async function facturarAlsea({ operador, noTicket, tienda, fecha, userData, outputDir }) {
  const ticketData = { operador, noTicket, tienda, fecha };

  // ── Paso 1: Validar RFC ─────────────────────────────────────────────────
  const payloadBase = buildPayload(ticketData, userData, false);

  const r1 = await postAPI('ValidaPagina1RFC', payloadBase);
  console.log(`[Alsea/${operador}] ValidaPagina1RFC → nivel=${r1.nivel} response=${r1.response}`);
  if (r1.response !== true) {
    return { ok: false, error: 'rfc_invalido', mensaje: extractExceptionMsg(r1.exception, 'RFC inválido o no registrado en el SAT.') };
  }

  // ── Paso 2: Validar Ticket ──────────────────────────────────────────────
  const r2 = await postAPI('ValidaPagina1Ticket', payloadBase);
  console.log(`[Alsea/${operador}] ValidaPagina1Ticket → nivel=${r2.nivel} response=${r2.response}`);
  console.log(`[Alsea/${operador}] Payload enviado: ticket=${payloadBase.ticket} tienda=${payloadBase.tienda} fecha=${payloadBase.fecha}`);
  if (r2.response !== true) {
    const excMsg = extractExceptionMsg(r2.exception, '');
    const excLower = excMsg.toLowerCase();
    console.log(`[Alsea/${operador}] Ticket rechazado: "${excMsg}"`);
    if (excLower.includes('ya fue facturado') || excLower.includes('facturado')) {
      return { ok: false, error: 'ya_facturado', mensaje: 'Este ticket ya fue facturado anteriormente.' };
    }
    if (excLower.includes('no existe') || excLower.includes('no encontr') || excLower.includes('no corresponde')) {
      return { ok: false, error: 'ticket_invalido', mensaje: excMsg || 'Ticket no encontrado. Verifica el número y la tienda.' };
    }
    return { ok: false, error: 'ticket_invalido', mensaje: excMsg || 'Ticket no válido.' };
  }

  // ── Paso 3: Validar Fecha ───────────────────────────────────────────────
  const r3 = await postAPI('ValidaPagina1Fecha', payloadBase);
  console.log(`[Alsea/${operador}] ValidaPagina1Fecha → nivel=${r3.nivel} response=${r3.response}`);
  if (r3.response !== true) {
    return { ok: false, error: 'fecha_invalida', mensaje: extractExceptionMsg(r3.exception, 'La fecha no coincide con el ticket.') };
  }

  // ── Paso 4: Re-validar RFC con datos fiscales ───────────────────────────
  const payloadFull = buildPayload(ticketData, userData, true);

  const r4 = await postAPI('ValidaPagina1RFC', payloadFull);
  console.log(`[Alsea/${operador}] ValidaPagina1RFC (fiscal) → nivel=${r4.nivel} response=${r4.response}`);
  if (r4.response !== true) {
    return { ok: false, error: 'datos_fiscales', mensaje: extractExceptionMsg(r4.exception, 'Datos fiscales rechazados por el SAT.') };
  }

  // ── Paso 5: Generar CFDI ────────────────────────────────────────────────
  const r5 = await postAPI('ValidaPagina2Facturar', payloadFull);
  console.log(`[Alsea/${operador}] ValidaPagina2Facturar → nivel=${r5.nivel}`);

  if (r5.nivel !== 99 || typeof r5.response !== 'string') {
    return { ok: false, error: extractExceptionMsg(r5.exception, 'Error generando factura.') };
  }

  // ── Descargar PDF y XML desde los links del Viewer ──────────────────────
  const links = extractLinks(r5.response);
  console.log(`[Alsea/${operador}] ${links.length} links de descarga encontrados`);

  if (links.length === 0) {
    return {
      ok: true,
      pdfPath: null,
      xmlPath: null,
      envioPorCorreo: true,
    };
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const prefix = `alsea_${operador}_${noTicket}`;

  let pdfPath = null;
  let xmlPath = null;

  // Link 0 = PDF, Link 1 = XML (orden observado en HAR)
  for (let i = 0; i < links.length && i < 2; i++) {
    const label     = i === 0 ? 'pdf' : 'xml';
    const tempPath  = path.join(outputDir, `${prefix}_temp_${label}`);

    try {
      const { contentType, size } = await descargarArchivo(links[i], tempPath);
      console.log(`[Alsea/${operador}] Descargado ${label}: ${size} bytes, ${contentType}`);

      // Determinar extensión real por Content-Type
      let ext = `.${label}`; // default por posición
      if (contentType.includes('pdf'))                        ext = '.pdf';
      else if (contentType.includes('xml'))                   ext = '.xml';
      else if (contentType.includes('html'))                  ext = '.html';

      const finalPath = path.join(outputDir, `${prefix}${ext}`);
      fs.renameSync(tempPath, finalPath);

      if (ext === '.pdf')  pdfPath = finalPath;
      if (ext === '.xml')  xmlPath = finalPath;

      // Si Content-Type no fue concluyente, asignar por posición
      if (ext !== '.pdf' && ext !== '.xml') {
        if (i === 0) pdfPath = finalPath;
        else         xmlPath = finalPath;
      }
    } catch (err) {
      console.error(`[Alsea/${operador}] Error descargando ${label}:`, err.message);
      // Limpiar archivo temporal si quedó
      try { fs.unlinkSync(tempPath); } catch {}
    }
  }

  return {
    ok:             true,
    pdfPath,
    xmlPath,
    envioPorCorreo: !pdfPath && !xmlPath,
  };
}

module.exports = { facturarAlsea, formatearFecha, splitNombre };
