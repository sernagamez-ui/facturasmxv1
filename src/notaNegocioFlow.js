/**
 * Flujo opcional: nota de negocio tras entregar CFDI (Telegram).
 */

const { Markup } = require('telegraf');

const OFERTA_TTL_MS = 15 * 60 * 1000;
const ESPERA_NOTA_MS = 10 * 60 * 1000;
const NOTA_MAX = 200;

/** Oferta inline reciente: key `${userId}|${k8}` → { uuid, ts } */
const pendingOferta = new Map();
const timersEspera = new Map();

function notaK8FromUuid(uuid) {
  return String(uuid || '')
    .replace(/-/g, '')
    .toLowerCase()
    .replace(/[^a-f0-9]/g, '')
    .slice(0, 8);
}

function registerPendingOferta(userId, fullUuid) {
  const u = String(userId);
  const k8 = notaK8FromUuid(fullUuid);
  if (k8.length < 8) return;
  pendingOferta.set(`${u}|${k8}`, { uuid: fullUuid, ts: Date.now() });
  // limpiar viejas del mismo user con uuid distinto — opcional; TTL lo cubre
}

function takePendingIfFresh(userId, k8) {
  const u = String(userId);
  const k = String(k8).toLowerCase().replace(/[^a-f0-9]/g, '').slice(0, 8);
  const rec = pendingOferta.get(`${u}|${k}`);
  if (!rec) return null;
  if (Date.now() - rec.ts > OFERTA_TTL_MS) {
    pendingOferta.delete(`${u}|${k}`);
    return null;
  }
  return rec.uuid;
}

function forgetPendingOferta(userId, k8) {
  const k = String(k8).toLowerCase().replace(/[^a-f0-9]/g, '').slice(0, 8);
  pendingOferta.delete(`${String(userId)}|${k}`);
}

function clearTimerEspera(userId) {
  const t = timersEspera.get(String(userId));
  if (t) clearTimeout(t);
  timersEspera.delete(String(userId));
}

/**
 * Limpia espera de nota (p. ej. timeout 10 min o nueva entrega de CFDI).
 */
function limpiarEsperaNota(db, userId) {
  clearTimerEspera(userId);
  const s = db.getState(String(userId));
  if (s && s.esperando_nota_uuid) {
    db.setState(String(userId), null);
  }
}

/**
 * Tras entregar archivos, si hay UUID ofrece botones.
 * El caller debe llamar a `limpiarEsperaNota` antes si aplica.
 */
function ofrecerNotaTrasCfdi(bot, { chatId, userId, uuid }) {
  if (!uuid) return;
  const k8 = notaK8FromUuid(uuid);
  if (k8.length < 8) return;

  registerPendingOferta(userId, String(uuid).trim());

  return bot.telegram
    .sendMessage(
      chatId,
      '¿Para qué fue este gasto? (opcional, útil para tu contador)',
      Markup.inlineKeyboard([
        [Markup.button.callback('📝 Agregar nota', `na:${k8}`), Markup.button.callback('Omitir', `no:${k8}`)],
      ])
    )
    .catch((err) => console.error('[notaNegocio] sendMessage oferta:', err.message));
}

function armarTextoPideNota() {
  return "Escribe una nota breve. Ej: 'Comida con cliente Grupo X, cierre propuesta'";
}

function enrutarNotaDespuesCfdi(bot, db) {
  bot.action(/^na:([0-9a-f]{8})$/i, async (ctx) => {
    await ctx.answerCbQuery();
    const userId = String(ctx.from.id);
    const k8 = ctx.match[1].toLowerCase();
    const full = takePendingIfFresh(userId, k8);
    if (!full) {
      return ctx
        .editMessageText('⏳ Esta oferta expiró. La próxima factura volverá a preguntar.')
        .catch(() => ctx.reply('⏳ Esta oferta expiró.'));
    }
    forgetPendingOferta(userId, k8);
    try {
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    } catch {
      // ya sin teclado
    }

    limpiarEsperaNota(db, userId);
    db.setState(userId, { esperando_nota_uuid: full });

    clearTimerEspera(userId);
    const tid = setTimeout(() => {
      if (db.getState(userId)?.esperando_nota_uuid === full) {
        db.setState(userId, null);
      }
      timersEspera.delete(userId);
    }, ESPERA_NOTA_MS);
    timersEspera.set(userId, tid);

    return ctx.reply(armarTextoPideNota());
  });

  bot.action(/^no:([0-9a-f]{8})$/i, async (ctx) => {
    await ctx.answerCbQuery();
    const userId = String(ctx.from.id);
    const k8 = ctx.match[1].toLowerCase();
    forgetPendingOferta(userId, k8);
    try {
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    } catch {
      // ok
    }
  });
}

/**
 * /nota <uuid8+>
 * @returns {boolean} true si se manejó (incluso error amigable)
 */
async function manejarComandoNota(ctx, db) {
  const userId = String(ctx.from.id);
  const raw = ctx.message?.text || '';
  if (!/^\s*\/nota(@\S+)?\b/i.test(raw)) return false;
  const arg = raw.replace(/^\s*\/nota(@\S+)?\s*/i, '').trim();
  if (!arg) {
    await ctx.reply('Uso: /nota y los primeros 8 caracteres del UUID (SAT) de la factura.\nEjemplo: /nota a1b2c3d4', {
      parse_mode: 'Markdown',
    });
    return true;
  }
  const key = arg.replace(/-/g, '').replace(/[^a-f0-9]/gi, '').slice(0, 8);
  if (key.length < 8) {
    await ctx.reply('El UUID abreviado son 8 caracteres (hex) del comprobante. Ejemplo: /nota a1b2c3d4');
    return true;
  }

  const found = db.findFacturaByUserIdAndUuidKey(userId, key);
  if (!found || !found.data) {
    await ctx.reply('No encontré esa factura. Usa *📊 Mis facturas* para ver tus UUIDs.', {
      parse_mode: 'Markdown',
    });
    return true;
  }

  const fullUuid = found.data.uuid;
  if (!fullUuid) {
    await ctx.reply('No encontré una factura con UUID. Usa *📊 Mis facturas* para ver tus comprobantes.', {
      parse_mode: 'Markdown',
    });
    return true;
  }

  limpiarEsperaNota(db, userId);
  db.setState(userId, { esperando_nota_uuid: String(fullUuid) });
  clearTimerEspera(userId);
  const tid = setTimeout(() => {
    if (db.getState(userId)?.esperando_nota_uuid === String(fullUuid)) {
      db.setState(userId, null);
    }
    timersEspera.delete(userId);
  }, ESPERA_NOTA_MS);
  timersEspera.set(userId, tid);

  await ctx.reply(armarTextoPideNota());
  return true;
}

/**
 * Procesa texto libre mientras `esperando_nota_uuid`.
 * @returns {boolean} true si consumió el mensaje
 */
async function manejarTextoNotaLibre(ctx, db) {
  const userId = String(ctx.from.id);
  const s = db.getState(userId);
  if (!s || !s.esperando_nota_uuid) return false;

  const texto = String(ctx.message.text || '').trim();
  if (!texto) return true;

  const targetUuid = s.esperando_nota_uuid;
  let nota = texto;
  let avisoCorte = '';
  if (nota.length > NOTA_MAX) {
    nota = nota.slice(0, NOTA_MAX);
    avisoCorte = `\n\n_Superaba ${NOTA_MAX} caracteres; la guardé recortada._`;
  }

  const r = db.actualizarNotaFactura(userId, targetUuid, nota);
  clearTimerEspera(userId);
  db.setState(userId, null);

  if (!r.ok) {
    await ctx.reply('No pude asociar la nota. Intenta de nuevo con *📊 Mis facturas* o /nota.', {
      parse_mode: 'Markdown',
    });
    return true;
  }

  await ctx.reply(`✅ Nota guardada${avisoCorte}`, { parse_mode: 'Markdown' });
  return true;
}

function escapeResumen(s) {
  if (!s) return '';
  return String(s)
    .replace(/[*_`[\]\\]/g, ' ')
    .replace(/\n/g, ' ')
    .trim();
}

module.exports = {
  NOTA_MAX,
  ESPERA_NOTA_MS,
  ofrecerNotaTrasCfdi,
  enrutarNotaDespuesCfdi,
  limpiarEsperaNota,
  manejarComandoNota,
  manejarTextoNotaLibre,
  escapeResumen,
};
