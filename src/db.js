/**
 * src/db.js — SQLite con WAL mode
 * Drop-in replacement de la versión JSON. Misma API.
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs   = require('fs');
const { resolveDataDir, IS_RAILWAY, hasRailwayVolume } = require('./dataDir');

const DATA_DIR = resolveDataDir();
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'cotas.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
console.log(`[db] SQLite path: ${DB_PATH}`);
if (IS_RAILWAY && !hasRailwayVolume()) {
  console.warn(
    '[db] Railway: no se detectó volumen persistente (RAILWAY_VOLUME_NAME / RAILWAY_VOLUME_MOUNT_PATH). ' +
      'Sin volumen montado en este servicio, los datos se pierden en cada redeploy. ' +
      'En Railway: Service → + Volume → mount path igual a DATA_DIR (p. ej. /data).'
  );
}

function normalizeId(id) {
  const raw = String(id ?? '').trim();
  const digits = raw.replace(/\D/g, '');
  // WhatsApp puede entregar 521XXXXXXXXXX mientras Meta usa 52XXXXXXXXXX.
  if (digits.startsWith('521') && digits.length === 13) return `52${digits.slice(3)}`;
  return digits || raw;
}

function legacyId(id) {
  return String(id ?? '').trim();
}

/** Inicio del día 1 del mes en America/Mexico_City expresado en ISO (RMF / usuarios MX). Sin DST en la mayoría del país. */
function mexicoMonthStartIsoUtc(year, month1to12) {
  const h = 6; // UTC−06:00 (Tiempo del Centro)
  return new Date(Date.UTC(year, month1to12 - 1, 1, h, 0, 0, 0)).toISOString();
}

function mexicoCalendarMonthFromDate(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Mexico_City',
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(d);
  return {
    year: Number(p.find((x) => x.type === 'year').value),
    month: Number(p.find((x) => x.type === 'month').value),
  };
}

function mexicoNextMonthYear(year, month1to12) {
  if (month1to12 === 12) return { year: year + 1, month: 1 };
  return { year, month: month1to12 + 1 };
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users    (id TEXT PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}');
  CREATE TABLE IF NOT EXISTS states   (id TEXT PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}');
  CREATE TABLE IF NOT EXISTS facturas (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS estaciones (nombre TEXT PRIMARY KEY, estacion_id TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_fac_user ON facturas(user_id);
  CREATE INDEX IF NOT EXISTS idx_fac_date ON facturas(created_at);
`);

const stmts = {
  getUser:      db.prepare('SELECT data FROM users WHERE id = ?'),
  setUser:      db.prepare('INSERT OR REPLACE INTO users (id, data) VALUES (?, ?)'),
  getState:     db.prepare('SELECT data FROM states WHERE id = ?'),
  setState:     db.prepare('INSERT OR REPLACE INTO states (id, data) VALUES (?, ?)'),
  delState:     db.prepare('DELETE FROM states WHERE id = ?'),
  addFactura:   db.prepare('INSERT INTO facturas (user_id, data, created_at) VALUES (?, ?, ?)'),
  getFactMes:   db.prepare('SELECT data FROM facturas WHERE user_id = ? AND created_at >= ? AND created_at < ?'),
  getAllFactMes: db.prepare('SELECT user_id, data FROM facturas WHERE created_at >= ? AND created_at < ?'),
  getEst:       db.prepare('SELECT estacion_id FROM estaciones WHERE nombre = ?'),
  setEst:       db.prepare('INSERT OR REPLACE INTO estaciones (nombre, estacion_id) VALUES (?, ?)'),
  updateFactura: db.prepare('UPDATE facturas SET data = ? WHERE id = ?'),
  getFacturasUser: db.prepare('SELECT id, data FROM facturas WHERE user_id = ? ORDER BY id DESC LIMIT 500'),
};

function getUser(id) {
  const key = normalizeId(id);
  const r = stmts.getUser.get(key) || stmts.getUser.get(legacyId(id));
  return r ? JSON.parse(r.data) : null;
}

function setUser(id, data) {
  const key = normalizeId(id);
  const current = getUser(key) || {};
  const next = { ...current, ...data };
  stmts.setUser.run(key, JSON.stringify(next));
}

function isOnboarded(id)   { const u = getUser(id); return !!(u && u.rfc && u.nombre && u.cp && u.regimen && u.email); }

function getState(id) {
  const key = normalizeId(id);
  const r = stmts.getState.get(key) || stmts.getState.get(legacyId(id));
  return r ? JSON.parse(r.data) : null;
}

function setState(id, s) {
  const key = normalizeId(id);
  s === null ? stmts.delState.run(key) : stmts.setState.run(key, JSON.stringify(s));
}

function guardarFactura(id, fac) {
  const data = { ...fac, guardadoEn: new Date().toISOString() };
  stmts.addFactura.run(normalizeId(id), JSON.stringify(data), data.guardadoEn);
}
function getFacturasMes(id, monthKey) {
  let s;
  let e;
  if (typeof monthKey === 'string' && /^\d{4}-\d{2}$/.test(monthKey)) {
    const [year, month] = monthKey.split('-').map(Number);
    s = mexicoMonthStartIsoUtc(year, month);
    const next = mexicoNextMonthYear(year, month);
    e = mexicoMonthStartIsoUtc(next.year, next.month);
  } else {
    const { year, month } = mexicoCalendarMonthFromDate(new Date());
    s = mexicoMonthStartIsoUtc(year, month);
    const next = mexicoNextMonthYear(year, month);
    e = mexicoMonthStartIsoUtc(next.year, next.month);
  }
  const key = normalizeId(id);
  const legacy = legacyId(id);
  const rows = key === legacy
    ? stmts.getFactMes.all(key, s, e)
    : [
        ...stmts.getFactMes.all(key, s, e),
        ...stmts.getFactMes.all(legacy, s, e),
      ];
  return rows.map(r => JSON.parse(r.data));
}
function getFacturasMesAnteriorTodos() {
  const { year, month } = mexicoCalendarMonthFromDate(new Date());
  const prev = month === 1 ? { y: year - 1, m: 12 } : { y: year, m: month - 1 };
  const s = mexicoMonthStartIsoUtc(prev.y, prev.m);
  const afterPrev = mexicoNextMonthYear(prev.y, prev.m);
  const e = mexicoMonthStartIsoUtc(afterPrev.year, afterPrev.month);
  const rows = stmts.getAllFactMes.all(s, e);
  const res = {};
  for (const r of rows) { if (!res[r.user_id]) res[r.user_id] = []; res[r.user_id].push(JSON.parse(r.data)); }
  return res;
}
function getEstacionId(n)    { const r = stmts.getEst.get((n||'').toLowerCase().trim()); return r ? r.estacion_id : null; }
function setEstacionId(n, id){ stmts.setEst.run((n||'').toLowerCase().trim(), id); }

/**
 * Compara UUID del SAT: admite 8 hex iniciales (sin guiones) o el UUID completo.
 * @returns {{ id: number, data: object } | null}
 */
function findFacturaByUserIdAndUuidKey(telegramId, uuidOrKey8) {
  const key = String(uuidOrKey8 || '')
    .replace(/-/g, '')
    .toLowerCase()
    .replace(/[^a-f0-9]/g, '');
  if (key.length < 8) return null;
  const k8 = key.slice(0, 8);
  const uid = normalizeId(telegramId);
  const legacy = legacyId(telegramId);
  const idSet = new Set();
  for (const userKey of [uid, legacy].filter((x, i, a) => a.indexOf(x) === i)) {
    for (const r of stmts.getFacturasUser.all(userKey) || []) {
      if (idSet.has(r.id)) continue;
      idSet.add(r.id);
      let d;
      try {
        d = JSON.parse(r.data);
      } catch {
        continue;
      }
      const u = (d.uuid || '').replace(/-/g, '').toLowerCase();
      if (u.length >= 8 && u.slice(0, 8) === k8) return { id: r.id, data: d };
    }
  }
  return null;
}

/**
 * @param {string} telegramId
 * @param {string} uuidOrKey8 — UUID completo o 8+ caracteres hex
 * @param {string|null} nota — null para borrar
 */
function actualizarNotaFactura(telegramId, uuidOrKey8, nota) {
  const found = findFacturaByUserIdAndUuidKey(telegramId, uuidOrKey8);
  if (!found) return { ok: false, error: 'not_found' };
  const s = nota == null || String(nota).trim() === '' ? null : String(nota).trim();
  const notaCorta = s == null ? null : s.slice(0, 200);
  const next = { ...found.data, nota_negocio: notaCorta };
  stmts.updateFactura.run(JSON.stringify(next), found.id);
  return { ok: true, data: next };
}

// Migración automática JSON → SQLite (una sola vez)
(function migrate() {
  if (db.prepare('SELECT COUNT(*) as c FROM users').get().c > 0) return;
  const rd = f => { try { return JSON.parse(fs.readFileSync(f,'utf8')); } catch { return null; } };
  const users = rd(path.join(DATA_DIR,'users.json'));
  if (users) { const tx = db.transaction(() => { for (const [k,v] of Object.entries(users)) stmts.setUser.run(k,JSON.stringify(v)); }); tx(); console.log(`[db] Migrados ${Object.keys(users).length} usuarios`); }
  const facs = rd(path.join(DATA_DIR,'facturas.json'));
  if (facs) { let c=0; const tx = db.transaction(() => { for (const [uid,arr] of Object.entries(facs)) for (const f of arr) { stmts.addFactura.run(uid,JSON.stringify(f),f.guardadoEn||new Date().toISOString()); c++; } }); tx(); console.log(`[db] Migradas ${c} facturas`); }
  const ests = rd(path.join(DATA_DIR,'estaciones_oxxo.json'));
  if (ests) { const tx = db.transaction(() => { for (const [n,id] of Object.entries(ests)) stmts.setEst.run(n,id); }); tx(); }
  const sts = rd(path.join(DATA_DIR,'states.json'));
  if (sts) { const tx = db.transaction(() => { for (const [k,v] of Object.entries(sts)) stmts.setState.run(k,JSON.stringify(v)); }); tx(); }
})();

/** Diagnóstico runtime: misma ruta que usa SQLite (para /health y soporte). */
function getStorageInfo() {
  let userRows = 0;
  let onboardedUsers = 0;
  try {
    userRows = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    for (const row of db.prepare('SELECT data FROM users').all()) {
      try {
        const u = JSON.parse(row.data);
        if (u?.rfc && u?.nombre && u?.cp && u?.regimen && u?.email) onboardedUsers++;
      } catch {
        // fila corrupta
      }
    }
  } catch {
    // DB no lista aún
  }
  return {
    dataDirResolved: DATA_DIR,
    dbPath: DB_PATH,
    dbFilePresent: fs.existsSync(DB_PATH),
    userRows,
    onboardedUsers,
    railwayVolumeAttached: hasRailwayVolume(),
    railwayVolumeName: process.env.RAILWAY_VOLUME_NAME || null,
    railwayVolumeMountPath: process.env.RAILWAY_VOLUME_MOUNT_PATH || null,
  };
}

module.exports = {
  getUser,
  setUser,
  isOnboarded,
  getState,
  setState,
  guardarFactura,
  getFacturasMes,
  getFacturasMesAnteriorTodos,
  getEstacionId,
  setEstacionId,
  getStorageInfo,
  actualizarNotaFactura,
  findFacturaByUserIdAndUuidKey,
};
