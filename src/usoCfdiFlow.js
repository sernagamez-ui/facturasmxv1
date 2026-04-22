/**
 * src/usoCfdiFlow.js — Selección de uso CFDI con botones inline
 */
const { determinarUsoCfdi, clasificarGasto, USOS_CFDI } = require('./fiscalRules');
const db = require('./db');

function verificarUsoCfdi(comercio, regimen, categoriaVision) {
  const r = determinarUsoCfdi(comercio, regimen, categoriaVision);
  return { necesitaPreguntar: r.preguntarAlUsuario && r.opciones.length > 1,
    usoCfdi: r.usoCfdi, opciones: r.opciones, labels: r.labels };
}

function generarBotonesUsoCfdi(comercio, opciones, labels, categoriaVision) {
  const g = clasificarGasto(comercio, { categoriaVision, skipClasificacionLog: true });
  const text = `${g.icon} *¿Para qué es esta compra?*\n\nNecesito el uso fiscal para tu factura de *${g.nombre}*:`;
  const buttons = opciones.map(cod => ({
    text: labels?.[cod] || `${cod} — ${USOS_CFDI[cod]||cod}`,
    callback_data: `usocfdi_${cod}`,
  }));
  return { text, buttons };
}

function guardarEstadoEsperandoUsoCfdi(userId, ticketData, fileId) {
  db.setState(userId, { step:'ESPERANDO_USO_CFDI', ticketData, fileId });
}

function recuperarEstadoUsoCfdi(userId) {
  const s = db.getState(userId);
  if (!s || s.step !== 'ESPERANDO_USO_CFDI') return null;
  db.setState(userId, null);
  return { ticketData: s.ticketData, fileId: s.fileId };
}

module.exports = { verificarUsoCfdi, generarBotonesUsoCfdi, guardarEstadoEsperandoUsoCfdi, recuperarEstadoUsoCfdi };
