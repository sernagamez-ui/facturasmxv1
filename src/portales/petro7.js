// src/portales/petro7.js
// Adaptador HTTP para Petro 7 — axios, sin Playwright, sin CAPTCHA
// Endpoints confirmados desde DevTools (Console + HAR)

const axios = require('axios');
const qs    = require('querystring');
const fs    = require('fs');
const path  = require('path');

const { getProxyAgent } = require('../proxyAgent');

const BASE_URL = 'https://tarjetapetro-7.com.mx/KJServices/webapi';

/** Misma idea que 7-Eleven: WAF suele devolver 403 a IPs de datacenter (Railway) sin proxy MX. */
function petro7Http(extra = {}) {
  const agent = getProxyAgent('rotating');
  if (!agent) return extra;
  return {
    ...extra,
    httpsAgent: agent,
    httpAgent: agent,
    proxy: false,
  };
}

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
    petro7Http({ headers: HEADERS, params: { estacion, fechaTicket, noTicket, webId } })
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
    petro7Http({ headers: { ...HEADERS, 'content-type': 'application/x-www-form-urlencoded' } })
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
    petro7Http({
      headers: HEADERS,
      params: { uuid, rfc, branding: 'petro' },
    })
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
    petro7Http({
      headers: HEADERS,
      params: { uuid, email },
    })
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

function mapPetro7HttpError(err) {
  const status = err.response?.status;
  if (status === 407) {
    return {
      ok: false,
      error: 'proxy_auth',
      userMessage:
        '🔐 *El proxy pide autenticación (HTTP 407).*\n\n' +
        'Revisa en Railway la variable `PROXY_URL_ROTATING`: formato `http://usuario:contraseña@host:puerto` ' +
        '(contraseña con caracteres especiales en *URL encode*).',
    };
  }
  if (status === 403 || status === 401) {
    return {
      ok: false,
      error: 'portal_forbidden',
      userMessage:
        '🚫 *Petro 7 rechazó la conexión desde el servidor (bloqueo por IP).*\n\n' +
        'No es un error de tu ticket: el portal suele bloquear IPs de datacenters (Railway, etc.).\n\n' +
        '*Qué hacer:* define `PROXY_URL_ROTATING` con un proxy HTTP residencial en México (mismo criterio que 7-Eleven; ver `src/proxyAgent.js`).\n\n' +
        '_Sin eso, la facturación automática desde la nube puede fallar._',
    };
  }
  return null;
}

// ─────────────────────────────────────────────
// ORQUESTADOR — llamado desde facturaRouter.js
// ─────────────────────────────────────────────
async function facturarPetro7({ gasolinera, folio, webId, fecha, userData, outputDir }) {
  if (getProxyAgent('rotating')) {
    console.log('[Petro7] peticiones vía PROXY_URL_ROTATING');
  }

  try {
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
      // Vision confunde 6↔5 en el primer dígito con frecuencia — reintento automático en ambos sentidos
      const estacionStr = String(ticket.estacion);
      let estacionCorregida = null;
      if (estacionStr.startsWith('5')) {
        estacionCorregida = '6' + estacionStr.slice(1);
        console.log(`[Petro7] status=4, reintentando con estación ${estacionCorregida} (corrigiendo 5→6)`);
      } else if (estacionStr.startsWith('6')) {
        estacionCorregida = '5' + estacionStr.slice(1);
        console.log(`[Petro7] status=4, reintentando con estación ${estacionCorregida} (corrigiendo 6→5)`);
      }
      if (estacionCorregida) {
        const v2 = await verificarTicket({ ...ticket, estacion: estacionCorregida });
        console.log(`[Petro7] reintento → status=${v2.status} mensaje="${v2.mensaje}"`);
        if (v2.valido) {
          ticket.estacion = estacionCorregida;
          Object.assign(v, v2);
        }
      }
      if (!v.valido) {
        return {
          ok: false, error: 'estacion_invalida', esperandoEstacion: true,
          userMessage:
            '⚠️ No pude leer bien el número de *Estación* del ticket (a veces se confunde con el código postal del encabezado).\n\n' +
            'Responde solo los *4 dígitos* junto a la palabra Estación (misma zona que Folio y Web ID).\n\n' +
            'Si el *Folio* (7 dígitos) también está mal, envía los dos separados por un espacio:\n`ESTACIÓN FOLIO`',
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
    if (mapPetro7HttpError(err)) throw err;
    console.error('[Petro7] Error descargando PDF:', err.message);
  }

  try {
    xmlPath = await descargarXml(cfdi.uuid, userData.email, outputDir);
  } catch (err) {
    if (mapPetro7HttpError(err)) throw err;
    console.error('[Petro7] Error descargando XML:', err.message);
  }

  const totalTicket = v.total != null && v.total !== '' ? Number(v.total) : undefined;

  return {
    ok:             true,
    uuid:           cfdi.uuid,
    pdfPath,
    xmlPath,
    envioPorCorreo: !pdfPath && !xmlPath,
    total:          Number.isFinite(totalTicket) ? totalTicket : undefined,
  };
  } catch (err) {
    const mapped = mapPetro7HttpError(err);
    if (mapped) return mapped;
    throw err;
  }
}

module.exports = { facturarPetro7, verificarTicket, generarFactura, formatearFecha };
