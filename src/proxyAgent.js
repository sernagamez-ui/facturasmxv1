const { HttpsProxyAgent } = require('https-proxy-agent');

const ENV_KEY = {
  sticky: 'PROXY_URL_STICKY',
  rotating: 'PROXY_URL_ROTATING',
};

/**
 * Normaliza y valida la URL del proxy (host + puerto obligatorios en el string).
 * @param {string|undefined} raw
 * @param {'sticky'|'rotating'} tipo
 * @returns {string|null}
 */
function parseProxyEnvUrl(raw, tipo) {
  if (raw == null || !String(raw).trim()) return null;
  const url = String(raw).trim();
  const key = ENV_KEY[tipo];
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `${key} no es una URL válida. Usa el formato completo: http(s)://usuario:contraseña@servidor:puerto`
    );
  }
  if (!parsed.hostname) {
    throw new Error(
      `${key} debe incluir servidor y puerto tras las credenciales (…@host:puerto). ` +
        'Si tu proveedor da host y puerto aparte, compón una sola URL en .env.'
    );
  }
  return url;
}

/**
 * Devuelve un HttpsProxyAgent configurado.
 * @param {'rotating'|'sticky'} tipo
 * @returns {HttpsProxyAgent|null} null si no hay PROXY_URL (local sin .env)
 */
function getProxyAgent(tipo = 'rotating') {
  const raw = tipo === 'sticky'
    ? process.env.PROXY_URL_STICKY
    : process.env.PROXY_URL_ROTATING;

  const url = parseProxyEnvUrl(raw, tipo === 'sticky' ? 'sticky' : 'rotating');
  if (!url) return null;
  return new HttpsProxyAgent(url);
}

/**
 * Devuelve config de proxy para Playwright.
 * @param {'rotating'|'sticky'} tipo
 * @returns {object|undefined}
 */
function getPlaywrightProxy(tipo = 'sticky') {
  const raw = tipo === 'sticky'
    ? process.env.PROXY_URL_STICKY
    : process.env.PROXY_URL_ROTATING;

  const url = parseProxyEnvUrl(raw, tipo === 'sticky' ? 'sticky' : 'rotating');
  if (!url) return undefined;

  const parsed = new URL(url);
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  return {
    server:   `${parsed.protocol}//${parsed.hostname}:${port}`,
    username: parsed.username,
    password: parsed.password,
  };
}

module.exports = { getProxyAgent, getPlaywrightProxy };
