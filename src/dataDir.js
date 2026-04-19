/**
 * Resolución única del directorio de datos (SQLite, sesiones, etc.)
 *
 * Orden:
 * 1. DATA_DIR si está definido (manual)
 * 2. RAILWAY_VOLUME_MOUNT_PATH — Railway lo inyecta cuando hay un volumen adjunto al servicio
 * 3. /data en Railway sin variable (convención habitual)
 * 4. ../data respecto a src/ en local
 */
const path = require('path');

const IS_RAILWAY = Boolean(process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_ENVIRONMENT_ID);

function resolveDataDir() {
  const explicit = process.env.DATA_DIR && String(process.env.DATA_DIR).trim();
  if (explicit) return path.resolve(explicit);

  const volMount = process.env.RAILWAY_VOLUME_MOUNT_PATH && String(process.env.RAILWAY_VOLUME_MOUNT_PATH).trim();
  if (volMount) return path.resolve(volMount);

  if (IS_RAILWAY) return '/data';

  return path.join(__dirname, '../data');
}

/** True si Railway reporta un volumen adjunto al servicio. */
function hasRailwayVolume() {
  return Boolean(process.env.RAILWAY_VOLUME_NAME && process.env.RAILWAY_VOLUME_MOUNT_PATH);
}

module.exports = { resolveDataDir, IS_RAILWAY, hasRailwayVolume };
