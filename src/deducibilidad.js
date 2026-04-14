/**
 * deducibilidad.js — Calcula cuánto es deducible e IVA acreditable
 * según el régimen fiscal del usuario para gastos de gasolina.
 *
 * Regímenes soportados:
 *   605 — Sueldos y Salarios (asalariado)
 *   612 — Actividades Empresariales y Profesionales (honorarios)
 *   626 — RESICO (Régimen Simplificado de Confianza)
 *
 * Regla fiscal clave para gasolina:
 *   - Solo deducible si se pagó con TARJETA o transferencia (art. 28 fracc. V LISR)
 *   - IVA acreditable solo si el gasto es deducible (art. 5 fracc. I LIVA)
 *   - Régimen 605 (asalariado): NO puede deducir gastos propios
 */

/**
 * Calcula la deducibilidad de un gasto de gasolina.
 * @param {number} total        — Monto total pagado (con IVA)
 * @param {string} metodoPago   — 'tarjeta' | 'efectivo'
 * @param {number|string} regimen — 605 | 612 | 626
 * @returns {object}
 */
function calcularDeducibilidadGasolina(total, metodoPago, regimen) {
  const reg = Number(regimen);
  const pagoElectronico = metodoPago === 'tarjeta';

  // Base sin IVA y monto de IVA (gasolina tiene IVA incluido al 16%)
  const subtotal = Math.round((total / 1.16) * 100) / 100;
  const iva      = Math.round((total - subtotal) * 100) / 100;

  // ── Régimen 605: Asalariado — no puede deducir ─────────────────────
  if (reg === 605) {
    return {
      deducible: false,
      montoDeducible: 0,
      ivaAcreditable: 0,
      porcentaje: 0,
      razon: 'Los asalariados (régimen 605) no pueden deducir gastos propios ante el SAT.',
      consejo: null,
    };
  }

  // ── Pago en efectivo: no deducible aunque tengas CFDI ─────────────
  if (!pagoElectronico) {
    return {
      deducible: false,
      montoDeducible: 0,
      ivaAcreditable: 0,
      porcentaje: 0,
      razon: 'La gasolina pagada en efectivo NO es deducible (Art. 28 fracc. V LISR), aunque tengas CFDI.',
      consejo: '💡 Para tu próxima carga, paga con tarjeta o transferencia y sí podrás deducirla.',
    };
  }

  // ── Régimen 612 (Honorarios) y 626 (RESICO): 100% deducible ───────
  if (reg === 612 || reg === 626) {
    return {
      deducible: true,
      montoDeducible: subtotal,
      ivaAcreditable: iva,
      porcentaje: 100,
      razon: reg === 612
        ? 'Deducible al 100% como gasto de la actividad (Art. 103 LISR).'
        : 'Deducible al 100% en RESICO (Art. 113-E LISR).',
      consejo: null,
    };
  }

  // ── Personas Morales (601, 603, 620, 622, 623, 624, 625) ──────────
  const REGIMENES_PM = [601, 603, 620, 622, 623, 624, 625];
  if (REGIMENES_PM.includes(reg)) {
    if (!pagoElectronico) {
      return {
        deducible: false,
        montoDeducible: 0,
        ivaAcreditable: 0,
        porcentaje: 0,
        razon: 'La gasolina pagada en efectivo NO es deducible para personas morales (Art. 28 fracc. V LISR).',
        consejo: '💡 Para tu próxima carga, paga con tarjeta o transferencia.',
      };
    }
    return {
      deducible: true,
      montoDeducible: subtotal,
      ivaAcreditable: iva,
      porcentaje: 100,
      razon: 'Deducible al 100% como gasto estrictamente indispensable (Art. 28 LISR).',
      consejo: null,
    };
  }

  // Régimen desconocido — conservador: no confirmar deducibilidad
  return {
    deducible: null,
    montoDeducible: null,
    ivaAcreditable: null,
    porcentaje: null,
    razon: 'Régimen fiscal no reconocido — consulta con tu contador.',
    consejo: null,
  };
}

/**
 * Genera el bloque de texto para incluir en el mensaje de WhatsApp al usuario.
 */
function mensajeDeducibilidad(ticketData, regimen) {
  const { total, metodoPago, tipoGasolina, litros } = ticketData;

  if (!total) return '';

  const resultado = calcularDeducibilidadGasolina(total, metodoPago || 'tarjeta', regimen);

  let msg = `\n━━━━━━━━━━━━━━━\n`;
  msg += `📊 *Análisis fiscal*\n`;

  if (litros)        msg += `⛽ ${litros} lts de ${tipoGasolina || 'gasolina'}\n`;
  msg += `💰 Total: $${Number(total).toFixed(2)} MXN\n\n`;

  if (resultado.deducible === true) {
    msg += `✅ *Deducible de ISR*\n`;
    msg += `   Monto deducible: $${resultado.montoDeducible.toFixed(2)}\n`;
    msg += `   IVA acreditable: $${resultado.ivaAcreditable.toFixed(2)}\n`;
    msg += `   ${resultado.razon}\n`;
  } else if (resultado.deducible === false) {
    msg += `❌ *No deducible*\n`;
    msg += `   ${resultado.razon}\n`;
    if (resultado.consejo) msg += `\n${resultado.consejo}\n`;
  } else {
    msg += `⚠️ ${resultado.razon}\n`;
  }

  return msg;
}

module.exports = { calcularDeducibilidadGasolina, mensajeDeducibilidad };
