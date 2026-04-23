/**
 * src/portales/homedepot.js — Adaptador HTTP para Home Depot México
 *
 * API REST puro con axios. Endpoints descubiertos vía HAR capture:
 *   BASE: https://facturacion.homedepot.com.mx:2053/CFDiConnectFacturacion/facturacion
 *
 * Flujo (10 pasos, todos 200 OK por HTTP directo):
 *   1. GET  /obtenerParametro?nombreParametro=ENABLE_LOGS   (sanity)
 *   2. GET  /validarEstadoCliente?rfcCliente={RFC}
 *   3. GET  /agregarTicket?noTicket={23d}                    ← THE JOY
 *   4. GET  /verificarComprobantePrevio?rfcReceptor=X&noTicket=Y
 *   5. GET  /getClientePorRFC?rfcCliente={RFC}
 *   6. GET  /obtenerTiendaPorNumero?noTienda={4d}
 *   7. GET  /indexSerieTienda?idTienda=X&tipoDocumento=FACTURA
 *   8. POST /timbrado                                         ← genera CFDI
 *   9. POST /guardarCliente
 *
 * Hallazgos HAR (2026-04-21):
 *   - CERO cookies, CERO sesión, CERO CSRF.
 *   - reCAPTCHA v3 Enterprise NO es validado server-side (cosmético).
 *   - `agregarTicket` devuelve conceptos con claves SAT pre-calculadas.
 *   - `timbrado` devuelve XML + PDF factura + PDF ticket en una sola respuesta.
 *
 * Rate limit observado: ninguno durante las pruebas (normal).
 * Ventana de facturación: 7 días naturales desde la compra.
 */

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const BASE    = 'https://facturacion.homedepot.com.mx:2053/CFDiConnectFacturacion/facturacion';
const REFERER = 'https://facturacion.homedepot.com.mx:2053/FacturacionWeb/';
const UA      = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

function makeClient() {
  return axios.create({
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
    validateStatus: () => true,
  });
}

// ─────────────────────────────────────────────
// LECTURA — 7 endpoints
// ─────────────────────────────────────────────

async function obtenerParametro(client) {
  const r = await client.get(`${BASE}/obtenerParametro`, {
    params: { nombreParametro: 'ENABLE_LOGS' },
  });
  if (r.status !== 200) throw new Error('Portal no disponible');
  return r.data;
}

async function validarEstadoCliente(client, rfc) {
  const r = await client.get(`${BASE}/validarEstadoCliente`, {
    params: { rfcCliente: rfc },
  });
  return r.data; // 404 "Cliente no encontrado" es válido para RFCs nuevos
}

async function agregarTicket(client, noTicket) {
  const r = await client.get(`${BASE}/agregarTicket`, {
    params: { noTicket },
  });
  if (r.status !== 200) {
    const err = new Error(`HTTP ${r.status} en agregarTicket`);
    err.code = 'http_error';
    err.httpStatus = r.status;
    throw err;
  }
  // Casos de alerta documentados en observaciones del HAR:
  if (r.data.alerta) {
    const mensaje = (r.data.mensaje || '').toLowerCase();
    const err = new Error(mensaje || 'ticket inválido');
    if (mensaje.includes('facturado'))       err.code = 'ticket_facturado';
    else if (mensaje.includes('encontrado')) err.code = 'ticket_no_encontrado';
    else if (mensaje.includes('vencido') || mensaje.includes('expirado')) err.code = 'ticket_vencido';
    else if (mensaje.includes('longitud'))  err.code = 'ticket_longitud_invalida';
    else                                     err.code = 'ticket_invalido';
    err.portalMessage = r.data.mensaje;
    throw err;
  }
  if (!r.data.tienda || !r.data.conceptos) {
    const err = new Error('Respuesta sin tienda/conceptos');
    err.code = 'respuesta_invalida';
    throw err;
  }
  return r.data;
}

/**
 * El ticket impreso bajo el código de barras suele traer 22 dígitos; el API exige 23
 * (p. ej. 0875200208186042026243 → 00875200208186042026243).
 */
function candidatosNoTicketHDM(soloDigitos) {
  const s = String(soloDigitos || '').replace(/\D/g, '');
  if (!s) return [];
  if (s.length === 23) return [s];
  const out = [];
  if (s.length === 22) {
    out.push('0' + s, s);
  } else if (s.length === 21) {
    out.push('00' + s, '0' + s, s);
  } else if (s.length === 20) {
    out.push('000' + s, '00' + s, '0' + s);
  } else if (s.length === 24) {
    out.push(s.slice(0, 23), s, s.slice(1));
  } else if (s.length === 25) {
    out.push(s.slice(0, 23), s.slice(1, 24), s.slice(2, 25));
  } else {
    out.push(s.padStart(23, '0'));
  }
  return [...new Set(out)];
}

async function agregarTicketConCandidatos(client, soloDigitos) {
  const candidatos = candidatosNoTicketHDM(soloDigitos);
  if (candidatos.length === 0) {
    const e = new Error('sin candidatos de ticket');
    e.code = 'ticket_formato_invalido';
    throw e;
  }
  let lastErr;
  for (let i = 0; i < candidatos.length; i++) {
    const nt = candidatos[i];
    try {
      const ticketData = await agregarTicket(client, nt);
      return { ticketData, noTicket: nt };
    } catch (e) {
      lastErr = e;
      const p = String(e.portalMessage || e.message || '').toLowerCase();
      if (e.code === 'ticket_facturado' || e.code === 'ticket_vencido') throw e;
      const puedeReintentar =
        e.code === 'ticket_longitud_invalida' ||
        (e.code === 'ticket_invalido' && p.includes('longitud')) ||
        e.code === 'ticket_no_encontrado' ||
        p.includes('no encontr');
      if (puedeReintentar && i < candidatos.length - 1) {
        console.log(
          `[HomeDepot] agregarTicket falló (${e.code} ${(e.portalMessage || '').slice(0, 60)}); probando otro noTicket...`
        );
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function verificarComprobantePrevio(client, rfc, noTicket) {
  const r = await client.get(`${BASE}/verificarComprobantePrevio`, {
    params: { rfcReceptor: rfc, noTicket },
  });
  return r.data; // { success:true } = ya facturado para ese RFC
}

async function getClientePorRFC(client, rfc) {
  const r = await client.get(`${BASE}/getClientePorRFC`, {
    params: { rfcCliente: rfc },
  });
  return r.data; // 404 = cliente nuevo
}

async function obtenerTiendaPorNumero(client, noTienda) {
  const r = await client.get(`${BASE}/obtenerTiendaPorNumero`, {
    params: { noTienda },
  });
  if (!r.data.id) throw new Error(`Tienda ${noTienda} no encontrada`);
  return r.data;
}

async function indexSerieTienda(client, idTienda) {
  const r = await client.get(`${BASE}/indexSerieTienda`, {
    params: { idTienda, tipoDocumento: 'FACTURA' },
  });
  if (!Array.isArray(r.data) || !r.data.length) {
    throw new Error('Serie de tienda no disponible');
  }
  return r.data[0];
}

// ─────────────────────────────────────────────
// ESCRITURA — timbrado + guardarCliente
// ─────────────────────────────────────────────

function buildPayloadTimbrado({ ticketData, tienda, serie, cliente, noTicket }) {
  const ahora = new Date();
  const pad   = n => String(n).padStart(2, '0');
  const fechaEmision =
    `${ahora.getFullYear()}-${pad(ahora.getMonth()+1)}-${pad(ahora.getDate())} ` +
    `${pad(ahora.getHours())}:${pad(ahora.getMinutes())}:${pad(ahora.getSeconds())}`;

  const conceptos = ticketData.conceptos.map((c, i) => ({
    id_concepto:      i + 1,
    clave:            c.clave,
    noIdentificacion: c.noIdentificacion,
    cantidad:         c.cantidad,
    claveUnidad:      c.claveUnidad,
    unidad:           c.unidad,
    descripcion:      c.descripcion,
    valorUnitario:    c.valorUnitario,
    importe:          c.importe,
    descuento:        c.descuento || 0,
    objetoImpuesto:   c.objetoImpuesto,
    traslados: (c.traslados || []).map((t, j) => ({
      idImpuesto: j,
      base:       t.base,
      impuesto:   '002',
      tipofactor: t.tipofactor,
      tasaCuota:  t.tasaCuota,
      importe:    t.importe,
    })),
    retenciones: c.retenciones || [],
  }));

  const totImpTras = conceptos.reduce((acc, c) =>
    acc + (c.traslados || []).reduce((s, t) => s + (t.importe || 0), 0), 0);

  const subTotal = ticketData.metodoPagoInfo?.totalTicket || 0;

  return {
    comprobante: {
      tipoComprobante:   serie.nombre,
      tipoDocumento:     'I',
      serieId:           '1',
      serieTiendaId:     String(serie.id),
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
      subTotal,
      descuento:         0,
      totImpTras,
      totImpRet:         0,
      total:             subTotal + totImpTras,
      totalDocumento:    subTotal + totImpTras,
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

async function timbrado(client, payload) {
  const r = await client.post(`${BASE}/timbrado`, payload, {
    headers: {
      'Content-Type': 'application/json',
      'Origin':       'https://facturacion.homedepot.com.mx:2053',
    },
  });
  if (r.status !== 200 || !r.data.success) {
    const err = new Error(r.data?.message || `HTTP ${r.status}`);
    err.code = 'timbrado_fallo';
    err.httpStatus = r.status;
    throw err;
  }
  return r.data;
}

async function guardarCliente(client, cliente) {
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
  return r.data; // no crítico — si falla, el CFDI ya está timbrado
}

// ─────────────────────────────────────────────
// ENTRY POINT — facturarHomeDepot
// ─────────────────────────────────────────────

/**
 * @param {object} p
 * @param {string} p.noTicket  — 23 dígitos debajo del código de barras
 * @param {object} p.userData  — { rfc, nombre, codigoPostal, regimen, correo, usoCfdi }
 * @param {string} p.outputDir — carpeta donde guardar xml/pdf
 * @returns {object} { ok, pdfPath, xmlPath, uuid, folio, serie, total } | { ok:false, error, userMessage }
 */
async function facturarHomeDepot({ noTicket, userData, outputDir }) {
  const tag = '[HomeDepot]';

  // ── Validación de entrada ───────────────────────────────────────────
  const ticket = String(noTicket || '').replace(/\D/g, '');
  if (ticket.length < 20 || ticket.length > 25) {
    return {
      ok: false,
      error: 'ticket_formato_invalido',
      userMessage:
        '🔍 *El número de ticket de Home Depot tiene 23 dígitos.*\n\n' +
        'Lo encuentras al final del código de barras, en la parte inferior del ticket.\n\n' +
        '¿Puedes mandarme otra foto donde se vea bien esa parte?',
    };
  }

  const rfc = String(userData.rfc || '').toUpperCase().trim();
  if (!rfc || (rfc.length !== 12 && rfc.length !== 13)) {
    return {
      ok: false,
      error: 'rfc_invalido',
      userMessage: '⚠️ El RFC no tiene formato válido (12 o 13 caracteres).',
    };
  }

  const cliente = {
    rfc,
    nombre:             userData.nombre || userData.razonSocial || '',
    // Telegram/onboarding guarda el CP en `cp` (igual que petro7, oxxo, mcdonald, officedepot)
    codigoPostal:       String(
      userData.codigoPostal || userData.cpFiscal || userData.cp || ''
    ).replace(/\D/g, '').slice(0, 5),
    claveRegimenFiscal: String(userData.regimen || userData.claveRegimenFiscal || '612').trim(),
    claveUsoCfdi:       String(userData.usoCfdi || userData.claveUsoCfdi || 'G03').trim(),
    correo:             String(userData.correo || userData.email || '').trim(),
  };

  if (!cliente.nombre || !cliente.codigoPostal || !cliente.correo) {
    return {
      ok: false,
      error: 'datos_fiscales_incompletos',
      userMessage: '⚠️ Faltan datos fiscales (nombre, código postal o correo).',
    };
  }

  const client = makeClient();

  try {
    const candidatos = candidatosNoTicketHDM(ticket);
    console.log(`${tag} Facturando (RFC ${rfc}) noTicket leído=${ticket} candidatos=[${candidatos.join(' | ')}]`);

    // 1. Sanity check
    await obtenerParametro(client);

    // 2. Estado del cliente (no crítico — solo informativo)
    await validarEstadoCliente(client, rfc).catch(() => null);

    // 3. Traer datos del ticket (reintento si 22↔23 dígitos u otro padding)
    console.log(`${tag} Consultando ticket...`);
    const { ticketData, noTicket: noTicketEfectivo } = await agregarTicketConCandidatos(client, ticket);
    console.log(`${tag} Ticket OK: noTicket=${noTicketEfectivo} tienda=${ticketData.tienda} total=$${ticketData.metodoPagoInfo?.totalTicket} conceptos=${ticketData.conceptos.length}`);

    // 4. ¿Ya facturado para este RFC?
    const prev = await verificarComprobantePrevio(client, rfc, noTicketEfectivo);
    if (prev.success === true) {
      return {
        ok: false,
        error: 'ticket_facturado',
        userMessage: '📋 Este ticket ya fue facturado previamente con tu RFC.',
      };
    }

    // 5. Cliente guardado (informativo)
    await getClientePorRFC(client, rfc).catch(() => null);

    // 6. Tienda completa
    const tienda = await obtenerTiendaPorNumero(client, ticketData.tienda);
    console.log(`${tag} Tienda: ${tienda.nombre}`);

    // 7. Serie de la tienda
    const serie = await indexSerieTienda(client, tienda.id);
    console.log(`${tag} Serie: ${serie.nombre}`);

    // 8. Timbrar
    console.log(`${tag} Timbrando...`);
    const payload = buildPayloadTimbrado({ ticketData, tienda, serie, cliente, noTicket: noTicketEfectivo });
    const cfdi = await timbrado(client, payload);
    console.log(`${tag} ✅ UUID=${cfdi.uuid} Folio=${cfdi.folio} Total=$${cfdi.total}`);

    // 9. Guardar cliente (no crítico)
    await guardarCliente(client, cliente).catch(err =>
      console.warn(`${tag} guardarCliente falló (no crítico): ${err.message}`)
    );

    // ── Guardar archivos ────────────────────────────────────────────
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const xmlPath = path.join(outputDir, `homedepot_${cfdi.folio}.xml`);
    const pdfPath = path.join(outputDir, `homedepot_${cfdi.folio}.pdf`);

    fs.writeFileSync(xmlPath, Buffer.from(cfdi.datab64,    'base64'));
    fs.writeFileSync(pdfPath, Buffer.from(cfdi.datab64PDF, 'base64'));

    return {
      ok:    true,
      pdfPath,
      xmlPath,
      uuid:  cfdi.uuid,
      folio: cfdi.folio,
      serie: cfdi.serie,
      total: cfdi.total,
      fecha: cfdi.fecha,
    };

  } catch (err) {
    console.error(`${tag} ❌`, err.code || 'error', '-', err.message);

    const messages = {
      ticket_formato_invalido:
        '🔍 El número del ticket tiene un formato inválido (deben ser 23 dígitos).',
      ticket_longitud_invalida:
        '🔍 El portal rechazó la longitud del folio. Revisa la línea *justo debajo del código de barras* (23 dígitos; a veces el impreso trae 22 y falta un cero al inicio).',
      ticket_facturado:
        '📋 Este ticket ya fue facturado anteriormente.',
      ticket_no_encontrado:
        '🔍 No encontré ese ticket en Home Depot.\n\n' +
        'Verifica los 23 dígitos *debajo del código de barras*. Si lo leíste del correo que te envió Home Depot, busca el PDF adjunto — ahí aparece el mismo código.',
      ticket_vencido:
        '⏰ *Este ticket ya venció.*\n\nHome Depot solo permite facturar durante *7 días naturales* después de la compra.',
      ticket_invalido:
        `⚠️ El portal de Home Depot rechazó el ticket: _${err.portalMessage || 'inválido'}_`,
      timbrado_fallo:
        `⚠️ El SAT rechazó la factura: _${err.message}_\n\nVerifica tus datos fiscales (RFC, régimen, CP) y vuelve a intentar.`,
      http_error:
        `⚠️ Home Depot no respondió (HTTP ${err.httpStatus}). Intenta en unos minutos.`,
    };

    return {
      ok:    false,
      error: err.code || 'error_desconocido',
      userMessage: messages[err.code] ||
        `⚠️ No pude tramitar la factura de Home Depot: ${err.message}`,
    };
  }
}

module.exports = { facturarHomeDepot };
