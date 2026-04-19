/**
 * src/adminRoutes.js — Health check + sesión OXXO Gas
 * Auth: header x-admin-key
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const { resolveDataDir } = require('./dataDir');

const DATA_DIR = resolveDataDir();
const SESSION_FILE = path.join(DATA_DIR, 'oxxogas-session.json');

function requireAdmin(req, res, next) {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_SECRET) return res.status(401).json({ error:'Unauthorized' });
  next();
}

router.get('/health', (req, res) => {
  const exists = fs.existsSync(SESSION_FILE);
  let age = null;
  if (exists) age = Math.round((Date.now() - fs.statSync(SESSION_FILE).mtimeMs) / 3600000);
  let queue = null;
  try { queue = require('./facturaQueue').stats(); } catch {}
  res.json({ status:'ok', uptime:Math.round(process.uptime()), session: exists ? `${age}h` : 'NO', queue, env:process.env.NODE_ENV });
});

router.get('/session', requireAdmin, (req, res) => {
  if (!fs.existsSync(SESSION_FILE)) return res.json({ exists:false });
  const age = Math.round((Date.now() - fs.statSync(SESSION_FILE).mtimeMs) / 3600000);
  let cookies = 0;
  try { cookies = JSON.parse(fs.readFileSync(SESSION_FILE,'utf8')).cookies?.length || 0; } catch {}
  res.json({ exists:true, horasDesdeUpdate:age, cookies, alerta: age > 72 ? 'Renovar sesión' : 'OK' });
});

router.post('/session', requireAdmin, express.json({ limit:'1mb' }), (req, res) => {
  if (!req.body?.cookies) return res.status(400).json({ error:'JSON inválido — necesita campo cookies' });
  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive:true });
  fs.writeFileSync(SESSION_FILE, JSON.stringify(req.body, null, 2));
  console.log(`[Admin] Sesión actualizada (${req.body.cookies.length} cookies)`);
  res.json({ ok:true, cookies:req.body.cookies.length });
});

module.exports = router;
