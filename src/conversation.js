/**
 * conversation.js — Flujo de onboarding y manejo de mensajes
 */

const wa      = require('./whatsapp');
const db      = require('./db');
const { setEstacionId } = db;
const { leerTicket }          = require('./ticketReader');
const { procesarFactura, comercioFacturableAutomatico, etiquetaComercio } = require('./facturaRouter');
const { registrarArchivos, urlArchivo } = require('./fileServer');

// RFC persona física: 4 letras + 6 dígitos + 3 alfanum = 13 chars
// RFC persona moral:  3 letras + 6 dígitos + 3 alfanum = 12 chars
const RFC_REGEX = /^[A-Z&Ñ]{3,4}[0-9]{6}[A-Z0-9]{3}$/i;

const REGIMENES_FISICA = {
  '605': 'Sueldos y Salarios (asalariado)',
  '612': 'Actividades Empresariales y Profesionales',
  '626': 'RESICO',
};

const REGIMENES_MORAL = {
  '601': 'General de Ley Personas Morales',
  '603': 'Personas Morales con Fines no Lucrativos',
  '620': 'Sociedades Cooperativas de Producción',
  '622': 'Actividades Agrícolas, Ganaderas, Silvícolas',
  '623': 'Opcional para Grupos de Sociedades',
  '624': 'Coordinados',
  '625': 'Régimen de las Actividades Empresariales con ingresos a través de plataformas',
};

function esPersonaMoral(rfc) {
  // Persona moral: RFC de 12 caracteres (3 letras iniciales)
  return rfc.replace(/\s/g, '').length === 12;
}

function getRegimenesDisponibles(rfc) {
  return esPersonaMoral(rfc) ? REGIMENES_MORAL : REGIMENES_FISICA;
}

function getTipoPersona(rfc) {
  return esPersonaMoral(rfc) ? 'moral' : 'física';
}

async function handleMessage(phone, msg) {
  const input = msg.type === 'text' ? msg.text.trim().toLowerCase() : '';

  if (input === 'reiniciar') {
    db.setUser(phone, {
      state: 'idle', stateData: {},
      rfc: null, nombre: null, cp: null, regimen: null, email: null,
    });
    await wa.sendText(phone, '♻️ Perfil reiniciado.\n\n' + mensajeBienvenida());
    return;
  }

  if (input === 'ayuda') {
    await wa.sendText(phone, mensajeAyuda());
    return;
  }

  if (input === 'resumen') {
    await enviarResumenMes(phone);
    return;
  }

  if (!db.isOnboarded(phone)) {
    await flujoOnboarding(phone, msg);
    return;
  }

  if (msg.type === 'image') {
    await procesarTicket(phone, msg.imageBuffer, msg.mimeType);
  } else if (msg.type === 'text') {
    const state = db.getState(phone);
    if (state === 'esperando_folio') {
      const folioTexto = msg.text.trim().replace(/\D/g, '');
      if (folioTexto.length >= 5) {
        const ticketData = db.getStateData(phone);
        ticketData.noTicket = folioTexto;
        db.clearState(phone);
        const user = db.getUser(phone);
        await wa.sendText(phone, `⏳ Tramitando factura con folio *${folioTexto}*...`);
        const resultado = await procesarFactura(ticketData, user, phone);
        await wa.sendText(phone, resultado.userMessage);
        if (resultado.ok && (resultado.xmlPath || resultado.pdfPath)) {
          await enviarArchivos(phone, resultado);
        }
      } else {
        await wa.sendText(phone, '❌ El folio debe tener al menos 5 dígitos. ¿Cuál es el número de Folio de tu ticket?');
      }
    } else if (state === 'esperando_estacion') {
      const inputUpper = msg.text.trim().toUpperCase().replace(/\s/g, '');
      if (/^E\d{3,6}$/.test(inputUpper)) {
        const ticketData = db.getStateData(phone);
        db.setEstacionId(ticketData.nombreEstacion, inputUpper);
        ticketData.estacion = inputUpper;
        db.clearState(phone);
        const user = db.getUser(phone);
        await wa.sendText(phone, `⏳ Tramitando factura de *${ticketData.nombreEstacion}*...`);
        const resultado = await procesarFactura(ticketData, user, phone);
        await wa.sendText(phone, resultado.userMessage);
        if (resultado.ok && (resultado.xmlPath || resultado.pdfPath)) {
          await enviarArchivos(phone, resultado);
        }
      } else {
        await wa.sendText(phone, '❌ El ID debe tener formato *E0000* (letra E seguida de números). Intenta de nuevo.');
      }
    } else {
      await wa.sendText(phone, '📸 Mándame una foto de tu ticket de gasolina para facturarlo.\n\nEscribe *ayuda* si necesitas asistencia.');
    }
  }
}

// ─────────────────────────────────────────────
// ONBOARDING
// ─────────────────────────────────────────────
async function flujoOnboarding(phone, msg) {
  const state = db.getState(phone);

  if (state === 'idle') {
    await wa.sendText(phone, mensajeBienvenida());
    db.setState(phone, 'ob_rfc');
    return;
  }

  if (msg.type !== 'text') {
    await wa.sendText(phone, '✍️ Por favor responde con texto para continuar el registro.');
    return;
  }

  const input = msg.text.trim();

  switch (state) {
    case 'ob_rfc': {
      const rfc = input.toUpperCase().replace(/\s/g, '');
      if (!RFC_REGEX.test(rfc)) {
        await wa.sendText(phone,
          '❌ RFC inválido. Verifica que sea correcto.\n\n' +
          '• Persona física: 13 caracteres (ej: GOML850101AB2)\n' +
          '• Persona moral: 12 caracteres (ej: ABC850101AB2)\n\n' +
          '¿Cuál es tu RFC?'
        );
        return;
      }
      db.setUser(phone, { rfc });
      db.setState(phone, 'ob_nombre');

      const tipo = getTipoPersona(rfc);
      const labelNombre = tipo === 'moral' ? 'Razón Social' : 'nombre completo';
      await wa.sendText(phone,
        `✅ RFC: *${rfc}* _(Persona ${tipo})_\n\n` +
        `¿Cuál es tu *${labelNombre}* tal como aparece en tu Constancia de Situación Fiscal?`
      );
      break;
    }

    case 'ob_nombre': {
      if (input.length < 3) {
        await wa.sendText(phone, '❌ Nombre muy corto. Escribe el nombre completo o razón social.');
        return;
      }
      db.setUser(phone, { nombre: input.toUpperCase() });
      db.setState(phone, 'ob_cp');
      await wa.sendText(phone,
        `✅ Nombre/Razón Social: *${input.toUpperCase()}*\n\n` +
        `¿Cuál es tu *Código Postal* fiscal (el de tu Constancia de Situación Fiscal)?`
      );
      break;
    }

    case 'ob_cp': {
      const cp = input.replace(/\s/g, '');
      if (!/^\d{5}$/.test(cp)) {
        await wa.sendText(phone, '❌ El Código Postal debe tener 5 dígitos. Intenta de nuevo.');
        return;
      }
      db.setUser(phone, { cp });
      db.setState(phone, 'ob_regimen');

      const user = db.getUser(phone);
      const regimenes = getRegimenesDisponibles(user.rfc);
      const tipo = getTipoPersona(user.rfc);

      let msgRegimen = `✅ CP: *${cp}*\n\n¿Cuál es tu régimen fiscal?\n\nResponde con el número:\n`;
      for (const [clave, desc] of Object.entries(regimenes)) {
        msgRegimen += `*${clave}* — ${desc}\n`;
      }
      await wa.sendText(phone, msgRegimen);
      break;
    }

    case 'ob_regimen': {
      const user = db.getUser(phone);
      const regimenes = getRegimenesDisponibles(user.rfc);

      if (!regimenes[input]) {
        let msgError = '❌ Elige uno de estos:\n';
        for (const [clave, desc] of Object.entries(regimenes)) {
          msgError += `*${clave}* — ${desc}\n`;
        }
        await wa.sendText(phone, msgError);
        return;
      }
      db.setUser(phone, { regimen: input });
      db.setState(phone, 'ob_email');
      await wa.sendText(phone,
        `✅ Régimen: *${regimenes[input]}*\n\n¿Cuál es tu correo para recibir las facturas?`
      );
      break;
    }

    case 'ob_email': {
      const email = input.toLowerCase().trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        await wa.sendText(phone, '❌ Correo inválido. Escríbelo de nuevo (ej: nombre@correo.com)');
        return;
      }
      db.setUser(phone, { email });
      db.clearState(phone);
      const user = db.getUser(phone);
      const regimenes = getRegimenesDisponibles(user.rfc);
      const tipo = getTipoPersona(user.rfc);

      await wa.sendText(phone,
        `🎉 *¡Registro completo!*\n\n` +
        `📋 RFC: ${user.rfc}\n` +
        `👤 ${tipo === 'moral' ? 'Razón Social' : 'Nombre'}: ${user.nombre}\n` +
        `📮 CP: ${user.cp}\n` +
        `🏛️ Régimen: ${regimenes[user.regimen]}\n` +
        `📧 Email: ${user.email}\n\n` +
        `━━━━━━━━━━━━━━━\n` +
        `⚙️ Preparando tu cuenta... un momento.`
      );

      // Auto-registro en portales — en background
      registrarEnPortales(user).then(resultados => {
        const listos   = resultados.filter(r => r.ok);
        const fallidos = resultados.filter(r => !r.ok);

        let msg = `⛽ *Puedes facturar en estos comercios:*\n\n`;
        msg += `*Gasolineras*\n`;
        msg += `  • Petro 7 ✅\n`;
        for (const r of listos)   msg += `  • ${r.portal} ✅\n`;
        for (const r of fallidos) msg += `  • ${r.portal} ⚠️\n`;
        msg += `\n*Próximamente*\n`;
        msg += `  • Hidrosina\n`;
        msg += `  • BP\n`;
        msg += `  • G500\n`;
        msg += `  • Mobil\n`;
        msg += `\n*Tiendas*\n`;
        msg += `  • OXXO ✅\n`;
        msg += `\n━━━━━━━━━━━━━━━\n`;
        msg += `📸 Mándame la foto de cualquier ticket de los comercios activos y facturo en segundos.`;

        wa.sendText(phone, msg).catch(console.error);
      }).catch(err => {
        console.error('[onboarding] Error en registro de portales:', err.message);
        wa.sendText(phone,
          `⛽ *Puedes facturar en:*\n• Petro 7 ✅\n• OXXO Gas ✅\n• OXXO tienda ✅\n\n📸 Mándame la foto de tu ticket.`
        ).catch(console.error);
      });

      break;
    }
  }
}

// ─────────────────────────────────────────────
// AUTO-REGISTRO EN PORTALES
// ─────────────────────────────────────────────
async function registrarEnPortales(user) {
  const resultados = [];

  try {
    const { registrarCuentaOxxoGas } = require('./portales/oxxogas');
    await registrarCuentaOxxoGas(user);
    resultados.push({ portal: 'OXXO Gas', ok: true });
    console.log(`[onboarding] ✅ OXXO Gas registrado para ${user.rfc}`);
  } catch (err) {
    resultados.push({ portal: 'OXXO Gas', ok: false, error: err.message });
    console.error(`[onboarding] ⚠️ OXXO Gas falló para ${user.rfc}:`, err.message);
  }

  return resultados;
}

// ─────────────────────────────────────────────
// PROCESAR TICKET
// ─────────────────────────────────────────────
async function procesarTicket(phone, imageBuffer, mimeType) {
  const user = db.getUser(phone);
  await wa.sendText(phone, '🔍 Leyendo tu ticket...');

  let ticketData;
  try {
    ticketData = await leerTicket(imageBuffer, mimeType);
  } catch (err) {
    await wa.sendText(phone, '❌ Error leyendo el ticket. Intenta con otra foto más clara.');
    return;
  }

  if (!ticketData.encontrado) {
    await wa.sendText(phone,
      '🤔 No pude identificar un ticket en esa imagen.\n\n' +
      '💡 Asegúrate de que:\n• La foto esté bien iluminada\n• El ticket esté plano y completo\n• No haya sombras sobre los números'
    );
    return;
  }

  if (!comercioFacturableAutomatico(ticketData.comercio)) {
    await wa.sendText(phone,
      `ℹ️ Detecté un ticket de *${ticketData.comercio || 'este comercio'}*.\n\n` +
      `Ese comercio aún no tiene facturación automática en Cotas por este canal.\n\n` +
      `Soportados: Petro 7, OXXO Gas, OXXO tienda, HEB, 7-Eleven, Office Depot / OfficeMax, marcas Alsea, Carl's Jr. / IHOP / BWW (Grupo Galería), McDonald's, etc.`
    );
    return;
  }

  await wa.sendText(
    phone,
    `⏳ Tramitando tu factura de *${etiquetaComercio(ticketData.comercio)}*... (puede tardar ~1 minuto)`
  );

  const resultado = await procesarFactura(ticketData, user, phone);

  if (resultado.esperandoFolio) {
    db.setState(phone, 'esperando_folio', resultado.ticketData);
  }

  if (resultado.esperandoEstacion) {
    db.setState(phone, 'esperando_estacion', resultado.ticketData);
  }

  await wa.sendText(phone, resultado.userMessage);

  if (resultado.ok && (resultado.xmlPath || resultado.pdfPath)) {
    await enviarArchivos(phone, resultado);
  }
}

// ─────────────────────────────────────────────
// ENVIAR ARCHIVOS POR WHATSAPP
// ─────────────────────────────────────────────
async function enviarArchivos(phone, resultado) {
  const ngrokUrl = process.env.NGROK_URL;

  if (!ngrokUrl) {
    await wa.sendText(phone,
      `📁 *Archivos generados:*\n` +
      (resultado.xmlPath ? `• XML ✓\n` : '') +
      (resultado.pdfPath ? `• PDF ✓\n` : '') +
      `\n⚙️ Configura NGROK_URL en .env para recibir los archivos aquí.\n` +
      `También los recibirás en tu correo registrado.`
    );
    return;
  }

  const token = registrarArchivos(resultado.xmlPath
    ? require('path').dirname(resultado.xmlPath)
    : require('path').dirname(resultado.pdfPath)
  );

  try {
    if (resultado.xmlPath) {
      const xmlUrl = urlArchivo(token, resultado.xmlPath);
      await wa.sendDocument(phone, xmlUrl, 'factura.xml', '📄 Factura XML (CFDI)');
      await new Promise(r => setTimeout(r, 1500));
    }
    if (resultado.pdfPath) {
      const pdfUrl = urlArchivo(token, resultado.pdfPath);
      await wa.sendDocument(phone, pdfUrl, 'factura.pdf', '📄 Factura PDF');
    }
  } catch (err) {
    console.error('[conversation] Error enviando archivos:', err.message);
    await wa.sendText(phone, '⚠️ Los archivos se generaron pero no pude enviarlos. Los recibirás en tu correo registrado.');
  }
}

// ─────────────────────────────────────────────
// RESUMEN MENSUAL
// ─────────────────────────────────────────────
async function enviarResumenMes(phone) {
  const user = db.getUser(phone);
  const ahora = new Date();
  const mes = ahora.toISOString().slice(0, 7); // 'YYYY-MM'
  const facturas = db.getFacturasMes(phone, mes);

  const nombreMes = ahora.toLocaleDateString('es-MX', { month: 'long', year: 'numeric' });

  if (facturas.length === 0) {
    await wa.sendText(phone,
      `📊 *Resumen de ${nombreMes}*\n\n` +
      `No tienes facturas registradas este mes.\n\n` +
      `📸 Mándame la foto de un ticket para empezar.`
    );
    return;
  }

  const totalGastado       = facturas.reduce((s, f) => s + (Number(f.total) || 0), 0);
  const totalDeducible     = facturas.filter(f => f.deducible).reduce((s, f) => s + (Number(f.montoDeducible) || 0), 0);
  const totalIVA           = facturas.filter(f => f.deducible).reduce((s, f) => s + (Number(f.ivaAcreditable) || 0), 0);
  const facturasDeducibles = facturas.filter(f => f.deducible).length;
  const facturasNo         = facturas.filter(f => f.deducible === false).length;

  // Estimado ISR (aprox 30% para 612, 25% para RESICO 626, 30% PM)
  const reg = Number(user?.regimen);
  const tasaISR = (reg === 626) ? 0.25 : 0.30;
  const isrEstimado = totalDeducible * tasaISR;

  let msg = `📊 *Resumen de ${nombreMes}*\n\n`;
  msg += `🧾 Facturas tramitadas: ${facturas.length}\n`;
  msg += `  • Deducibles: ${facturasDeducibles}\n`;
  if (facturasNo > 0) msg += `  • No deducibles: ${facturasNo}\n`;
  msg += `\n`;
  msg += `💰 *Total gastado:* $${totalGastado.toFixed(2)} MXN\n`;
  msg += `\n━━━━━━━━━━━━━━━\n`;
  msg += `📋 *Para tu declaración:*\n\n`;
  msg += `✅ Base deducible ISR: $${totalDeducible.toFixed(2)}\n`;
  msg += `🔵 IVA acreditable: $${totalIVA.toFixed(2)}\n`;
  msg += `💎 Ahorro ISR estimado (~${Math.round(tasaISR * 100)}%): $${isrEstimado.toFixed(2)}\n`;
  msg += `\n_Este resumen es orientativo. Valida con tu contador antes de declarar._`;

  await wa.sendText(phone, msg);
}

// ─────────────────────────────────────────────
// MENSAJES ESTÁTICOS
// ─────────────────────────────────────────────
function mensajeBienvenida() {
  return `👋 *¡Bienvenido a Cotas!*\n\n` +
    `Soy tu agente de facturación automática. Mándame la foto de tu ticket de gasolina y yo tramito el CFDI por ti. ⛽\n\n` +
    `Primero necesito registrarte (1 minuto).\n\n` +
    `¿Cuál es tu *RFC*? _(persona física o moral)_`;
}

function mensajeAyuda() {
  return `🤖 *Cotas — Comandos*\n\n` +
    `📸 *Foto de ticket* — Tramitar factura automáticamente\n` +
    `*resumen* — Ver cuánto dedujiste este mes\n` +
    `*reiniciar* — Volver a registrarme\n` +
    `*ayuda* — Ver esta lista\n\n` +
    `Gasolineras: Petro 7 · OXXO Gas`;
}

module.exports = { handleMessage };
