/**
 * fileServer.js — Sirve archivos temporales de facturas via URL pública
 * Los archivos se exponen en /files/:token/:filename
 * Se auto-eliminan después de 10 minutos
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// Map de token → { dir, expireAt }
const _tokens = new Map();

/**
 * Registra un directorio de archivos y retorna un token de acceso temporal.
 * @param {string} dir — directorio con los archivos XML/PDF
 * @returns {string} token
 */
function registrarArchivos(dir) {
  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  _tokens.set(token, {
    dir,
    expireAt: Date.now() + 10 * 60 * 1000, // 10 minutos
  });
  // Limpiar tokens vencidos
  for (const [k, v] of _tokens.entries()) {
    if (v.expireAt < Date.now()) _tokens.delete(k);
  }
  return token;
}

/**
 * Resuelve un token + filename a una ruta local.
 * Retorna null si el token no existe, venció, o el archivo no existe.
 */
function resolverArchivo(token, filename) {
  const entry = _tokens.get(token);
  if (!entry) return null;
  if (entry.expireAt < Date.now()) { _tokens.delete(token); return null; }

  // Sanitizar filename (no permitir path traversal)
  const safe = path.basename(filename);
  const fullPath = path.join(entry.dir, safe);
  if (!fs.existsSync(fullPath)) return null;
  return fullPath;
}

/**
 * Construye la URL pública de un archivo.
 * BASE_URL viene de ngrok (NGROK_URL en .env) o localhost para pruebas.
 */
function urlArchivo(token, filename) {
  const base = (process.env.NGROK_URL || `http://localhost:${process.env.PORT || 3000}`)
    .replace(/\/$/, '');
  return `${base}/files/${token}/${encodeURIComponent(path.basename(filename))}`;
}

/**
 * Middleware Express para servir los archivos.
 * Registrar en server.js: app.use(fileServerMiddleware)
 */
function fileServerMiddleware(req, res, next) {
  const match = req.path.match(/^\/files\/([^/]+)\/(.+)$/);
  if (!match) return next();

  const [, token, filename] = match;
  const filePath = resolverArchivo(token, decodeURIComponent(filename));

  if (!filePath) {
    return res.status(404).send('Archivo no encontrado o expirado');
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.xml': 'application/xml',
    '.pdf': 'application/pdf',
  };

  res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
  fs.createReadStream(filePath).pipe(res);
}

module.exports = { registrarArchivos, urlArchivo, fileServerMiddleware };
