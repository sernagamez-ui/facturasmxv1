/**
 * test_homedepot.js — Diagnóstico standalone del portal Home Depot
 *
 * Fase 2 del proceso estándar: prueba los endpoints HTTP DIRECTOS del portal
 * de facturación de Home Depot (`facturacion.homedepot.com.mx:2053`) ANTES de
 * integrar al bot.
 *
 * HIPÓTESIS a validar:
 *   1. El API es 100% HTTP (axios puro) — como Petro 7 y 7-Eleven.
 *   2. No hay cookies de sesión, no hay auth token, no hay CSRF.
 *   3. El reCAPTCHA v3 Enterprise que el portal hace en `validarRecaptcha`
 *      es COSMÉTICO — el backend NO lo enforza en `agregarTicket` / `timbrado`.
 *
 * Si la hipótesis se confirma, construimos el adaptador de producción como
 * petro7.js (axios puro, sin Playwright). Si NO se confirma, el script nos
 * dirá exactamente en qué paso truena y agregamos Playwright solo para el
 * token de reCAPTCHA (híbrido mínimo).
 *
 * USO:
 *   node test_homedepot.js <ticket> [rfc] [--timbrar]
 *
 * Por defecto corre en modo LECTURA (NO genera factura real). Pasa --timbrar
 * para ejecutar también los POST de escritura (`timbrado`, `guardarCliente`).
 *
 * Ejemplos:
 *   node test_homedepot.js 00875200208187042026991 SEGC9001195V8
 *     → lectura de 5 endpoints, sin generar CFDI
 *
 *   node test_homedepot.js 00875200208187042026992 SEGC9001195V8 --timbrar
 *     → flujo completo incluyendo timbrado (ticket NO facturado previamente)
 *
 * Requisitos:  npm i axios
 */

const axios  = require('axios');
const fs     = require('fs');
const path   = require('path');

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const BASE    = 'https://facturacion.homedepot.com.mx:2053/CFDiConnectFacturacion/facturacion';
const REFERER = 'https://facturacion.homedepot.com.mx:2053/FacturacionWeb/';
const UA      = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const DEBUG_DIR = path.join(__dirname, 'debug_homedepot');
if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

// Datos fiscales de prueba (override con argumentos si hace falta)
const DEFAULT_CLIENTE = {
  rfc:               'SEGC9001195V8',
  nombre:            'CARLOS ALBERTO SERNA GAMEZ',
  codigoPostal:      '66220',
  claveRegimenFiscal:'612',
  claveUsoCfdi:      'G03',
  correo:            'sernagamez@gmail.com',
};

// ─────────────────────────────────────────────
// CLIENT AXIOS — headers copiados del HAR
// ─────────────────────────────────────────────
const client = axios.create({
  timeout: 30000,
  headers: {
    'Accept':             'application/json, text/plain, */*',
    'Accept-Language':    'es-ES,es;q=0.9',
    'Cache-Control':      'no-cache',
    'Pragma':             'no-cache',
    'Referer':            REFERER,
    'User-Agent':         UA,
    'sec-ch-ua':          '"Chromium";v="145", "Not:A-Brand";v="99"',
    'sec-ch-ua-mobile':   '?0',
    'sec-ch-ua-platform': '"macOS"',
    'sec-fetch-dest':     'empty',
    'sec-fetch-mode':     'cors',
    'sec-fetch-site':     'same-origin',
  },
  validateStatus: () => true, // inspeccionar manualmente cualquier status
});

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function log(tag, ...args) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${tag}]`, ...args);
}

function divider(msg) {
  console.log('');
  console.log('═'.repeat(72));
  console.log(`  ${msg}`);
  console.log('═'.repeat(72));
}

function save(name, obj) {
  const file = path.join(DEBUG_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  log('SAVE', `→ ${file}`);
}

function saveBinary(name, b64) {
  if (!b64) return;
  const file = path.join(DEBUG_DIR, name);
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  log('SAVE', `→ ${file} (${fs.statSync(file).size} bytes)`);
}

function truncate(s, n = 120) {
  if (typeof s !== 'string') return s;
  return s.length > n ? s.slice(0, n) + '…[TRUNCATED]' : s;
}

// ─────────────────────────────────────────────
// ENDPOINTS — uno por función, fácil de debuggear
// ─────────────────────────────────────────────

async function obtenerParametro() {
  const r = await client.get(`${BASE}/obtenerParametro`, {
    params: { nombreParametro: 'ENABLE_LOGS' },
  });
  log('STATUS', r.status);
  log('BODY  ', JSON.stringify(r.data));
  save('01_obtenerParametro', { status: r.status, data: r.data });
  if (r.status !== 200) throw new Error('Portal no responde a /obtenerParametro');
  return r.data;
}

async function validarEstadoCliente(rfc) {
  const r = await client.get(`${BASE}/validarEstadoCliente`, {
    params: { rfcCliente: rfc },
  });
  log('STATUS', r.status);
  log('BODY  ', JSON.stringify(r.data));
  save('02_validarEstadoCliente', { status: r.status, data: r.data });
  // 404 "Cliente no encontrado" es NORMAL para RFCs nuevos. No es error.
  return r.data;
}

async function agregarTicket(noTicket) {
  const r = await client.get(`${BASE}/agregarTicket`, {
    params: { noTicket },
  });
  log('STATUS', r.status);

  if (r.status === 403 || r.status === 401) {
    log('❌', 'HTTP BLOQUEADO — probablemente reCAPTCHA enforced server-side.');
    log('❌', 'Hay que usar Playwright para extraer token de reCAPTCHA primero.');
    save('04_agregarTicket_BLOCKED', { status: r.status, data: r.data });
    throw new Error('reCAPTCHA enforced — falla en agregarTicket');
  }

  log('BODY  ', JSON.stringify(r.data, null, 2));
  save('04_agregarTicket', { status: r.status, data: r.data });

  if (r.status !== 200) {
    throw new Error(`agregarTicket devolvió ${r.status}: ${JSON.stringify(r.data)}`);
  }
  if (r.data.alerta || r.data.codigo === 404) {
    throw new Error(`Ticket no encontrado: ${r.data.mensaje || 'sin mensaje'}`);
  }
  if (!r.data.tienda || !r.data.conceptos) {
    log('⚠️ ', 'Respuesta sin tienda/conceptos — ticket inválido o expirado');
    throw new Error('Respuesta de agregarTicket no contiene tienda/conceptos');
  }
  return r.data;
}

async function verificarComprobantePrevio(rfc, noTicket) {
  const r = await client.get(`${BASE}/verificarComprobantePrevio`, {
    params: { rfcReceptor: rfc, noTicket },
  });
  log('STATUS', r.status);
  log('BODY  ', JSON.stringify(r.data));
  save('05_verificarComprobantePrevio', { status: r.status, data: r.data });
  return r.data; // { success: true, ...} = YA facturado. success: false = se puede timbrar.
}

async function getClientePorRFC(rfc) {
  const r = await client.get(`${BASE}/getClientePorRFC`, {
    params: { rfcCliente: rfc },
  });
  log('STATUS', r.status);
  log('BODY  ', JSON.stringify(r.data));
  save('06_getClientePorRFC', { status: r.status, data: r.data });
  return r.data; // codigo:404 = cliente nuevo, hay que usar guardarCliente después
}

async function obtenerTiendaPorNumero(noTienda) {
  const r = await client.get(`${BASE}/obtenerTiendaPorNumero`, {
    params: { noTienda },
  });
  log('STATUS', r.status);
  log('BODY  ', JSON.stringify(r.data, null, 2));
  save('07_obtenerTiendaPorNumero', { status: r.status, data: r.data });
  if (!r.data.id) throw new Error('obtenerTiendaPorNumero no devolvió id');
  return r.data;
}

async function indexSerieTienda(idTienda) {
  const r = await client.get(`${BASE}/indexSerieTienda`, {
    params: { idTienda, tipoDocumento: 'FACTURA' },
  });
  log('STATUS', r.status);
  log('BODY  ', JSON.stringify(r.data, null, 2));
  save('08_indexSerieTienda', { status: r.status, data: r.data });
  if (!Array.isArray(r.data) || !r.data.length) {
    throw new Error('indexSerieTienda no devolvió series');
  }
  return r.data[0]; // primera serie activa
}

// ── Escritura (solo con --timbrar) ────────────────────────────────

function construirPayloadTimbrado({ ticketData, tienda, serie, cliente, noTicket }) {
  const ahora = new Date();
  const pad   = n => String(n).padStart(2, '0');
  const fechaEmision =
    `${ahora.getFullYear()}-${pad(ahora.getMonth()+1)}-${pad(ahora.getDate())} ` +
    `${pad(ahora.getHours())}:${pad(ahora.getMinutes())}:${pad(ahora.getSeconds())}`;

  // Conceptos vienen tal cual del portal, solo agregamos id_concepto y re-mapeamos impuesto
  const conceptos = ticketData.conceptos.map((c, i) => ({
    id_concepto:    i + 1,
    clave:          c.clave,
    noIdentificacion: c.noIdentificacion,
    cantidad:       c.cantidad,
    claveUnidad:    c.claveUnidad,
    unidad:         c.unidad,
    descripcion:    c.descripcion,
    valorUnitario:  c.valorUnitario,
    importe:        c.importe,
    descuento:      c.descuento || 0,
    objetoImpuesto: c.objetoImpuesto,
    traslados: (c.traslados || []).map((t, j) => ({
      idImpuesto: j,
      base:       t.base,
      impuesto:   '002',          // IVA → SAT "002"
      tipofactor: t.tipofactor,
      tasaCuota:  t.tasaCuota,
      importe:    t.importe,
    })),
    retenciones: c.retenciones || [],
  }));

  const totImpTras = conceptos.reduce((acc, c) =>
    acc + (c.traslados || []).reduce((s, t) => s + (t.importe || 0), 0), 0);

  return {
    comprobante: {
      tipoComprobante:   serie.nombre,          // ej "4KHGEBI"
      tipoDocumento:     'I',
      serieId:           '1',
      serieTiendaId:     String(serie.id),      // ej "191"
      fechaEmision,
      moneda:            'MXN',
      tipoCambio:        1,
      exportacion:       '01',
      formaPago:         ticketData.metodoPagoInfo?.tipoPago?.formaPago || '01',
      condicionesPago:   ticketData.metodoPagoInfo?.condicionesPago || 'PAGADO',
      metodoPago:        ticketData.metodoPagoInfo?.metodoPago || 'PUE',
      lugarExpedicion:   tienda.codigoPostal,
      canalEmision:      'WEB',
      rfcEmisor:         tienda.emisorRfc,
      nombreEmisor:      tienda.emisorNombre,
      regimenEmisor:     '',
      rfcReceptor:       cliente.rfc,
      nombreReceptor:    cliente.nombre.toLowerCase(),
      domicilioReceptor: cliente.codigoPostal,
      regimenReceptor:   cliente.claveRegimenFiscal,
      usoCFDI:           cliente.claveUsoCfdi,
      correo:            cliente.correo,
      activo:            true,
      direccionReceptor: `Código Postal: ${cliente.codigoPostal}`,
      calle:             'NO ESPECIFICADO',
      numeroExterior:    'S/N',
      numeroInterior:    '',
      colonia:           'NO ESPECIFICADO',
      municipio:         'NO ESPECIFICADO',
      estado:            'NO ESPECIFICADO',
      pais:              'MEXICO',
      conceptos,
      relacionados:      [],
      tickets:           [noTicket],
      noClienteAR:       '',
      ordenCompra:       '',
      subTotal:          ticketData.metodoPagoInfo?.totalTicket || 0,
      descuento:         0,
      totImpTras,
      totImpRet:         0,
      total:             ticketData.metodoPagoInfo?.totalTicket || 0,
      totalDocumento:    ticketData.metodoPagoInfo?.totalTicket || 0,
      tieneDetallista:   false,
      tipoOperacion:     ticketData.tipoTransaccion || 'VTA',
      orderReference:    ticketData.orderReference || '',
      emisor: {
        id:             tienda.emisorId,
        rfc:            tienda.emisorRfc,
        razonSocial:    tienda.emisorNombre,
        regimen_fiscal: '',
        codigoPostal:   tienda.codigoPostal,
        calle:          tienda.calle,
        noExterior:     tienda.noExterior,
        noInterior:     tienda.noInterior,
        colonia:        tienda.colonia,
        municipio:      tienda.municipio,
        estado:         tienda.estado,
        pais:           tienda.pais,
        localidad:      tienda.localidad,
        telefono:       tienda.telefono,
        estatus:        tienda.estatus,
      },
      tienda: {
        id:            tienda.id,
        nombre:        tienda.nombre,
        noTienda:      tienda.noTienda,
        codigoPostal:  tienda.codigoPostal,
        calle:         tienda.calle,
        noExterior:    tienda.noExterior,
        noInterior:    tienda.noInterior,
        colonia:       tienda.colonia,
        municipio:     tienda.municipio,
        estado:        tienda.estado,
        pais:          tienda.pais,
        localidad:     tienda.localidad,
        telefono:      tienda.telefono,
        emisorId:      tienda.emisorId,
        emisorNombre:  tienda.emisorNombre,
        emisorRfc:     tienda.emisorRfc,
        estatus:       tienda.estatus,
      },
    },
  };
}

async function timbrado(payload) {
  const r = await client.post(`${BASE}/timbrado`, payload, {
    headers: {
      'Content-Type': 'application/json',
      'Origin':       'https://facturacion.homedepot.com.mx:2053',
    },
  });
  log('STATUS', r.status);
  // No imprimir datab64 completo en consola — son MB
  const summary = {
    success:          r.data.success,
    message:          r.data.message,
    uuid:             r.data.uuid,
    serie:            r.data.serie,
    folio:            r.data.folio,
    fecha:            r.data.fecha,
    total:            r.data.total,
    correo:           r.data.correo,
    datab64_len:      r.data.datab64?.length || 0,
    datab64PDF_len:   r.data.datab64PDF?.length || 0,
    datab64Ticket_len:r.data.datab64PDFTicket?.length || 0,
  };
  log('BODY  ', JSON.stringify(summary, null, 2));
  save('09_timbrado_response', { status: r.status, summary });

  // Guardar XML y PDFs como archivos reales
  saveBinary('cfdi.xml',        r.data.datab64);
  saveBinary('cfdi_factura.pdf',r.data.datab64PDF);
  saveBinary('cfdi_ticket.pdf', r.data.datab64PDFTicket);

  if (!r.data.success) {
    throw new Error(`timbrado falló: ${r.data.message}`);
  }
  return r.data;
}

async function guardarCliente(cliente) {
  const payload = {
    rfc:                cliente.rfc,
    nombre:             cliente.nombre.toLowerCase(),
    tipo:               'PISO',
    codigoPostal:       cliente.codigoPostal,
    claveRegimenFiscal: cliente.claveRegimenFiscal,
    claveUsoCfdi:       cliente.claveUsoCfdi,
    correo:             cliente.correo,
    calle:              '',
    numeroExterior:     '',
    numeroInterior:     '',
    colonia:            '',
    municipio:          '',
    estado:             'México',
    pais:               'México',
    activo:             true,
  };
  const r = await client.post(`${BASE}/guardarCliente`, payload, {
    headers: {
      'Content-Type': 'application/json',
      'Origin':       'https://facturacion.homedepot.com.mx:2053',
    },
  });
  log('STATUS', r.status);
  log('BODY  ', JSON.stringify(r.data));
  save('10_guardarCliente', { status: r.status, data: r.data });
  return r.data;
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter(a => a.startsWith('--')));
  const positional = args.filter(a => !a.startsWith('--'));

  const noTicket = positional[0];
  const rfc      = (positional[1] || DEFAULT_CLIENTE.rfc).toUpperCase();
  const doTimbrar = flags.has('--timbrar');

  if (!noTicket) {
    console.log('USO: node test_homedepot.js <ticket> [rfc] [--timbrar]');
    console.log('');
    console.log('Ejemplo (solo lectura):');
    console.log('  node test_homedepot.js 00875200208187042026991 SEGC9001195V8');
    console.log('');
    console.log('Ejemplo (timbrar de verdad — ticket NO facturado previamente):');
    console.log('  node test_homedepot.js 00875200208187042026992 SEGC9001195V8 --timbrar');
    process.exit(1);
  }

  const cliente = { ...DEFAULT_CLIENTE, rfc };

  divider('CONFIG');
  log('TICKET  ', noTicket, `(len=${noTicket.length})`);
  log('RFC     ', rfc);
  log('MODO    ', doTimbrar ? 'TIMBRAR (escritura real)' : 'SOLO LECTURA');
  log('DEBUG   ', DEBUG_DIR);

  // ─── PASO 1: Sanity check ─────────────────────────────
  divider('PASO 1 — obtenerParametro (sanity check)');
  await obtenerParametro();

  // ─── PASO 2: Cliente existe en DB del portal? ─────────
  divider('PASO 2 — validarEstadoCliente');
  await validarEstadoCliente(rfc);

  // ─── PASO 3: LA PRUEBA DE FUEGO ───────────────────────
  // Sin llamar /validarRecaptcha primero, ¿agregarTicket responde?
  divider('PASO 3 — agregarTicket (SIN reCAPTCHA previo)');
  log('TEST ', '→ si esto funciona sin reCAPTCHA, HTTP puro es viable');
  const ticketData = await agregarTicket(noTicket);
  log('✅ OK ', `Tienda ${ticketData.tienda}, total $${ticketData.metodoPagoInfo?.totalTicket}, ${ticketData.conceptos.length} concepto(s)`);

  // ─── PASO 4: ya facturado? ────────────────────────────
  divider('PASO 4 — verificarComprobantePrevio');
  const prev = await verificarComprobantePrevio(rfc, noTicket);
  const yaFacturado = prev.success === true;
  if (yaFacturado) {
    log('ℹ️ ', 'TICKET YA FACTURADO — el flujo de lectura funciona.');
    log('ℹ️ ', 'Para probar timbrado, usa un ticket NUEVO con --timbrar');
  }

  // ─── PASO 5: Datos cliente ────────────────────────────
  divider('PASO 5 — getClientePorRFC');
  await getClientePorRFC(rfc);

  // ─── PASO 6: Tienda ───────────────────────────────────
  divider('PASO 6 — obtenerTiendaPorNumero');
  const tienda = await obtenerTiendaPorNumero(ticketData.tienda);

  // ─── PASO 7: Serie ────────────────────────────────────
  divider('PASO 7 — indexSerieTienda');
  const serie = await indexSerieTienda(tienda.id);

  // ─── FIN DE LECTURA ───────────────────────────────────
  divider('DIAGNÓSTICO DE LECTURA — ✅ COMPLETO');
  log('✅', 'Todos los endpoints de LECTURA funcionan por HTTP puro.');
  log('✅', 'La hipótesis se confirma: reCAPTCHA es cosmético.');
  log('✅', `Ticket válido: tienda=${tienda.noTienda} (${tienda.nombre}), serie=${serie.nombre}`);

  if (!doTimbrar) {
    log('ℹ️ ', '');
    log('ℹ️ ', 'Pasa --timbrar con un ticket NO facturado para probar timbrado real.');
    return;
  }
  if (yaFacturado) {
    log('❌', 'No se ejecuta --timbrar: ticket ya facturado (evitar duplicado).');
    return;
  }

  // ─── PASO 8: TIMBRADO REAL ────────────────────────────
  divider('PASO 8 — timbrado (GENERA CFDI)');
  const payload = construirPayloadTimbrado({
    ticketData, tienda, serie, cliente, noTicket,
  });
  save('09_timbrado_request', payload);
  const cfdi = await timbrado(payload);
  log('✅ OK ', `UUID=${cfdi.uuid} Folio=${cfdi.folio} Serie=${cfdi.serie} Total=$${cfdi.total}`);

  // ─── PASO 9: Guardar cliente ──────────────────────────
  divider('PASO 9 — guardarCliente');
  await guardarCliente(cliente);

  divider('FLUJO COMPLETO — ✅ ÉXITO');
  log('✅', `XML, PDF factura y PDF ticket guardados en ${DEBUG_DIR}`);
  log('✅', `UUID CFDI: ${cfdi.uuid}`);
}

main().catch(err => {
  console.error('');
  console.error('═'.repeat(72));
  console.error('  ❌ FALLO');
  console.error('═'.repeat(72));
  console.error(err.message);
  if (err.response) {
    console.error('Response status:', err.response.status);
    console.error('Response data:  ', truncate(JSON.stringify(err.response.data), 500));
  }
  console.error('');
  console.error(`Revisa ${DEBUG_DIR} para los JSON guardados de cada paso.`);
  process.exit(1);
});
