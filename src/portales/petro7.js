// src/portales/petro7.js
// Adaptador HTTP para Petro 7 — axios, sin Playwright, sin CAPTCHA
// Endpoints confirmados desde DevTools (Console + HAR)

const axios = require('axios');
const qs    = require('querystring');
const fs    = require('fs');
const path  = require('path');

const BASE_URL = 'https://tarjetapetro-7.com.mx/KJServices/webapi';

// Credencial estática hardcodeada en kportalexterno.js del portal
// Decodificado: kextwebapi:kli0ts0us02ws3rbr0k0wtm1c
const BASIC_AUTH = 'Basic a2V4dHdlYmFwaTprbGkwdHMwdXMwMndzM3JicjBrMHd0bTFj';

const HEADERS = {
  'accept':        'application/json, text/plain, */*',
  'authorization': BASIC_AUTH,
  'referer':       'https://tarjetapetro-7.com.mx/KPortalExterno/',
  'origin':        'https://tarjetapetro-7.com.mx',
  'user-agent':    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
};

// ─────────────────────────────────────────────
// PASO 1: Verificar ticket
// status "0" → válido y facturable  ✅ (confirmado en HAR)
// status "2" → ya fue facturado
// status "3" → ticket no existe
// ─────────────────────────────────────────────
async function verificarTicket({ estacion, noTicket, fechaTicket, webId }) {
  const res = await axios.get(
    `${BASE_URL}/FacturacionService/verificaTicketWS2`,
    { headers: HEADERS, params: { estacion, fechaTicket, noTicket, webId } }
  );
  const d = res.data;
  return {
    valido:    d.status === '0',
    status:    d.status,
    mensaje:   d.mensajeValidacion,
    total:     d.totalTicket,
    formaPago: d.formaPago,
  };
}

// ─────────────────────────────────────────────
// PASO 2: Generar CFDI
// ─────────────────────────────────────────────
async function generarFactura(ticket, receptor) {
  const ticketArr = [{
    noEstacion:  ticket.estacion,
    noTicket:    ticket.noTicket,
    wid:         ticket.webId,
    fechaTicket: ticket.fechaTicket,
    id:          null,
  }];

  const body = {
    calle:                 '',
    ciudad:                '',
    colonia:               '',
    cp:                    receptor.cp,
    delegacion:            '',
    email:                 receptor.email,
    facturaExpress:        'true',
    facturaRegistrado:     'true',
    formaPagoAux:          receptor.formaPago || '01',
    idCliente:             '-1',
    medioEmision:          'AUTOFACTURACIÓN',
    noExterior:            '',
    noInterior:            '',
    pais:                  '',
    razon:                 receptor.razon.toUpperCase(),
    regimenFiscalReceptor: receptor.regimen,
    rfc:                   receptor.rfc.toUpperCase(),
    selectedFormaPago:     receptor.formaPago || '01',
    tickets:               JSON.stringify(ticketArr),
    usoCFDI:               receptor.usoCfdi || 'G03',
  };

  const res = await axios.post(
    `${BASE_URL}/FacturaExpressService`,
    qs.stringify(body),
    { headers: { ...HEADERS, 'content-type': 'application/x-www-form-urlencoded' } }
  );

  const r = res.data[0];
  return {
    exito:   r.cfdiDisponible === true,
    uuid:    r.uuid,
    mensaje: r.respuesta,
  };
}

// ─────────────────────────────────────────────
// PASO 3a: Descargar PDF
// Respuesta: { b64Pdf, rfcEmisor, rfcReceptor, serie, folio }
// ─────────────────────────────────────────────
async function descargarPdf(uuid, rfc, outputDir) {
  const res = await axios.get(
    `${BASE_URL}/FacturaExpressService/descargaCfdiPdf`,
    {
      headers: HEADERS,
      params: { uuid, rfc, branding: 'petro' },
    }
  );

  const d = res.data;
  if (!d.b64Pdf) throw new Error('PDF vacío en respuesta');

  const filename = `${d.rfcEmisor}_${d.rfcReceptor}_${d.serie}_${d.folio}.pdf`;
  const pdfPath  = path.join(outputDir, filename);

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(pdfPath, Buffer.from(d.b64Pdf, 'base64'));

  console.log(`[Petro7] ✅ PDF guardado: ${filename}`);
  return pdfPath;
}

// ─────────────────────────────────────────────
// PASO 3b: Descargar XML
// Respuesta: { xml, rfcEmisor, rfcReceptor, serie, folio }
// ─────────────────────────────────────────────
async function descargarXml(uuid, email, outputDir) {
  const res = await axios.get(
    `${BASE_URL}/FacturaExpressService/descargaCfdiXml`,
    {
      headers: HEADERS,
      params: { uuid, email },
    }
  );

  const d = res.data;
  if (!d.xml) throw new Error('XML vacío en respuesta');

  const filename = `${d.rfcEmisor}_${d.rfcReceptor}_${d.serie}_${d.folio}.xml`;
  const xmlPath  = path.join(outputDir, filename);

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(xmlPath, d.xml, 'utf8');

  console.log(`[Petro7] ✅ XML guardado: ${filename}`);
  return xmlPath;
}

// ─────────────────────────────────────────────
// HELPER: Formato de fecha
// Acepta "DD/MM/YYYY" o "YYYY-MM-DD"
// Retorna "YYYY-MM-DDT06:00:00.000Z"
// ─────────────────────────────────────────────
function formatearFecha(fechaStr) {
  let yyyy, mm, dd;
  if (fechaStr.includes('/')) {
    [dd, mm, yyyy] = fechaStr.split('/');
  } else {
    [yyyy, mm, dd] = fechaStr.split('-');
  }
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T06:00:00.000Z`;
}

// ─────────────────────────────────────────────
// ORQUESTADOR — llamado desde facturaRouter.js
// ─────────────────────────────────────────────
async function facturarPetro7({ gasolinera, folio, webId, fecha, userData, outputDir }) {
  const fechaFormateada = formatearFecha(fecha);

  const ticket = {
    estacion:    gasolinera,
    noTicket:    folio,
    fechaTicket: fechaFormateada,
    webId:       webId || 'C5E8',
  };

  // Paso 1: verificar
  const v = await verificarTicket(ticket);
  console.log(`[Petro7] verificarTicket → status=${v.status} mensaje="${v.mensaje}"`);

  if (!v.valido) {
    if (v.status === '2') {
      return { ok: false, error: 'ya_facturado', mensaje: 'Este ticket ya fue facturado anteriormente.' };
    }
    if (v.status === '4') {
      // Vision confunde 6 con 5 frecuentemente — reintento automático
      const estacionStr = String(ticket.estacion);
      if (estacionStr.startsWith('5')) {
        const estacionCorregida = '6' + estacionStr.slice(1);
        console.log(`[Petro7] status=4, reintentando con estación ${estacionCorregida} (corrigiendo 5→6)`);
        const v2 = await verificarTicket({ ...ticket, estacion: estacionCorregida });
        console.log(`[Petro7] reintento → status=${v2.status} mensaje="${v2.mensaje}"`);
        if (v2.valido) {
          ticket.estacion = estacionCorregida;
          Object.assign(v, v2);
        } else {
          return {
            ok: false, error: 'estacion_invalida', esperandoEstacion: true,
            userMessage: '⚠️ No pude leer bien el número de estación del ticket.\n\nResponde con el número de *Estación* que aparece en tu ticket (4 dígitos) y lo intento de nuevo.',
          };
        }
      } else {
        return {
          ok: false, error: 'estacion_invalida', esperandoEstacion: true,
          userMessage: '⚠️ No pude leer bien el número de estación del ticket.\n\nResponde con el número de *Estación* que aparece en tu ticket (4 dígitos) y lo intento de nuevo.',
        };
      }
    }
    // Si llegamos aquí desde status=4 con retry exitoso, v.valido ya es true — no fallar
    if (v.valido) { /* retry exitoso — continuar */ }
    else { return { ok: false, error: "ticket_invalido", mensaje: v.mensaje || "Ticket no encontrado." }; }
  }

  // Paso 2: generar CFDI
  const receptor = {
    rfc:       userData.rfc,
    razon:     userData.nombre,
    cp:        userData.cp,
    regimen:   userData.regimen,
    email:     userData.email,
    formaPago: v.formaPago || '01',
    usoCfdi:   userData.usoCfdi || ({'605':'S01'}.hasOwnProperty(userData.regimen) ? 'S01' : 'G03'),
  };

  const cfdi = await generarFactura(ticket, receptor);
  console.log(`[Petro7] generarFactura → exito=${cfdi.exito} uuid=${cfdi.uuid}`);

  if (!cfdi.exito) {
    return { ok: false, error: cfdi.mensaje || 'Error generando CFDI' };
  }

  // Paso 3: descargar PDF y XML
  let pdfPath = null;
  let xmlPath = null;

  try {
    pdfPath = await descargarPdf(cfdi.uuid, userData.rfc, outputDir);
  } catch (err) {
    console.error('[Petro7] Error descargando PDF:', err.message);
  }

  try {
    xmlPath = await descargarXml(cfdi.uuid, userData.email, outputDir);
  } catch (err) {
    console.error('[Petro7] Error descargando XML:', err.message);
  }

  return {
    ok:             true,
    uuid:           cfdi.uuid,
    pdfPath,
    xmlPath,
    envioPorCorreo: !pdfPath && !xmlPath,
  };
}

module.exports = { facturarPetro7, verificarTicket, generarFactura, formatearFecha };
