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
 * Intenta PROXY_URL_STICKY / PROXY_URL_ROTATING; si el parse falla, usa
 * PROXY_STICKY_HOST, PROXY_STICKY_PORT, PROXY_STICKY_USER, PROXY_STICKY_PASS.
 * @param {'rotating'|'sticky'} tipo
 * @returns {object|undefined}
 */
function getPlaywrightProxy(tipo = 'sticky') {
  const raw =
    tipo === 'sticky'
      ? process.env.PROXY_URL_STICKY
      : process.env.PROXY_URL_ROTATING;

  const url = raw != null ? String(raw).trim() : '';
  if (url) {
    try {
      const parsed = new URL(url);
      if (!parsed.hostname) throw new Error('sin hostname');
      const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
      let password = parsed.password;
      try {
        password = decodeURIComponent(parsed.password);
      } catch (_) {
        password = parsed.password;
      }
      return {
        server: `${parsed.protocol}//${parsed.hostname}:${port}`,
        username: parsed.username,
        password,
      };
    } catch (_) {}
  }

  const host = process.env.PROXY_STICKY_HOST;
  const port = process.env.PROXY_STICKY_PORT;
  const user = process.env.PROXY_STICKY_USER;
  const pass = process.env.PROXY_STICKY_PASS;

  if (host && port && user && pass != null && String(pass) !== '') {
    return {
      server: `http://${String(host).trim()}:${String(port).trim()}`,
      username: String(user).trim(),
      password: String(pass).trim(),
    };
  }

  return undefined;
}

/**
 * Proxy Playwright solo para OXXO tienda (https://…:9443/).
 * Muchos proxies residenciales rechazan CONNECT a puertos distintos de 443 → ERR_TUNNEL_CONNECTION_FAILED.
 * Por defecto no se usa proxy aquí. Activa OXXO_TIENDA_USE_PLAYWRIGHT_PROXY=1 si tu proveedor permite el puerto.
 * @returns {object|undefined}
 */
function getPlaywrightProxyOxxoTienda() {
  if (String(process.env.OXXO_TIENDA_USE_PLAYWRIGHT_PROXY || '').trim() !== '1') {
    return undefined;
  }
  return getPlaywrightProxy();
}

module.exports = {
  getProxyAgent,
  getPlaywrightProxy,
  getPlaywrightProxyOxxoTienda,
};
