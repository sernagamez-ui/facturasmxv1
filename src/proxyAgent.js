const { HttpsProxyAgent } = require('https-proxy-agent');
const proxyChain = require('proxy-chain');

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
 * Usa PROXY_URL_SOCKS5 cuando OXXO_TIENDA_USE_PLAYWRIGHT_PROXY=1.
 * Sin username/password si el proveedor autentica por IP whitelist (p. ej. IPRoyal).
 * @returns {object|undefined}
 */
function getPlaywrightProxyOxxoTienda() {
  if (String(process.env.OXXO_TIENDA_USE_PLAYWRIGHT_PROXY || '').trim() !== '1') {
    return undefined;
  }
  const url = process.env.PROXY_URL_SOCKS5;
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return {
      server: `socks5://${parsed.hostname}:${parsed.port}`,
      // sin username ni password — IPRoyal autentica por IP whitelist
    };
  } catch (_) {
    return undefined;
  }
}

/**
 * Playwright para OXXO Gas cuando OXXOGAS_USE_PLAYWRIGHT_PROXY=1.
 * Orden: OXXOGAS_PROXY_URL → PROXY_URL_SOCKS5 → PROXY_URL_STICKY (HTTP).
 * El túnel HTTP a facturacion.oxxogas.com suele dar ERR_TUNNEL_CONNECTION_FAILED;
 * SOCKS5 suele funcionar mejor con el mismo proveedor.
 * @returns {object|undefined}
 */
function getPlaywrightProxyOxxoGas() {
  if (String(process.env.OXXOGAS_USE_PLAYWRIGHT_PROXY || '').trim() !== '1') {
    return undefined;
  }

  const tryUrl = (raw, label) => {
    const s = raw != null ? String(raw).trim() : '';
    if (!s) return null;
    try {
      const p = new URL(s);
      if (p.protocol === 'socks5:' || p.protocol === 'socks4:') {
        const port = p.port || '1080';
        let password = p.password;
        try {
          password = decodeURIComponent(p.password);
        } catch (_) {
          password = p.password;
        }
        const o = { server: `socks5://${p.hostname}:${port}` };
        if (p.username) {
          o.username = p.username;
          o.password = password || '';
        }
        return o;
      }
      const port = p.port || (p.protocol === 'https:' ? '443' : '80');
      let password = p.password;
      try {
        password = decodeURIComponent(p.password);
      } catch (_) {
        password = p.password;
      }
      return {
        server: `${p.protocol}//${p.hostname}:${port}`,
        username: p.username || undefined,
        password: password || undefined,
      };
    } catch (e) {
      console.warn(`[proxyAgent] ${label} URL inválida:`, e.message);
      return null;
    }
  };

  let cfg = tryUrl(process.env.OXXOGAS_PROXY_URL, 'OXXOGAS_PROXY_URL');
  if (cfg) return cfg;

  cfg = tryUrl(process.env.PROXY_URL_SOCKS5, 'PROXY_URL_SOCKS5');
  if (cfg) return cfg;

  return getPlaywrightProxy();
}

/**
 * Playwright para Soriana cuando SORIANA_USE_PLAYWRIGHT_PROXY=1.
 * Orden: SORIANA_PROXY_URL → PROXY_URL_SOCKS5 → PROXY_URL_STICKY (getPlaywrightProxy).
 * El portal suele devolver texto tipo "GF R01 BLocked!" desde IPs de hosting sin proxy MX.
 * @returns {object|undefined}
 */
function getPlaywrightProxySoriana() {
  if (String(process.env.SORIANA_USE_PLAYWRIGHT_PROXY || '').trim() !== '1') {
    return undefined;
  }

  const tryUrl = (raw, label) => {
    const s = raw != null ? String(raw).trim() : '';
    if (!s) return null;
    try {
      const p = new URL(s);
      if (p.protocol === 'socks5:' || p.protocol === 'socks4:') {
        const port = p.port || '1080';
        let password = p.password;
        try {
          password = decodeURIComponent(p.password);
        } catch (_) {
          password = p.password;
        }
        const o = { server: `socks5://${p.hostname}:${port}` };
        if (p.username) {
          o.username = p.username;
          o.password = password || '';
        }
        return o;
      }
      const port = p.port || (p.protocol === 'https:' ? '443' : '80');
      let password = p.password;
      try {
        password = decodeURIComponent(p.password);
      } catch (_) {
        password = p.password;
      }
      return {
        server: `${p.protocol}//${p.hostname}:${port}`,
        username: p.username || undefined,
        password: password || undefined,
      };
    } catch (e) {
      console.warn(`[proxyAgent] Soriana ${label} URL inválida:`, e.message);
      return null;
    }
  };

  let cfg = tryUrl(process.env.SORIANA_PROXY_URL, 'SORIANA_PROXY_URL');
  if (cfg) return cfg;

  cfg = tryUrl(process.env.PROXY_URL_SOCKS5, 'PROXY_URL_SOCKS5');
  if (cfg) return cfg;

  return getPlaywrightProxy();
}

/**
 * Igual que prepareOxxoGasPlaywrightProxy pero para Soriana (SORIANA_USE_PLAYWRIGHT_PROXY).
 * @returns {Promise<{ proxy: object|undefined, teardown: () => Promise<void> }>}
 */
async function prepareSorianaPlaywrightProxy() {
  const p = getPlaywrightProxySoriana();
  if (!p) {
    return { proxy: undefined, teardown: async () => {} };
  }

  const hasAuth =
    (p.username != null && String(p.username) !== '') ||
    (p.password != null && String(p.password) !== '');
  if (!hasAuth) {
    return { proxy: p, teardown: async () => {} };
  }

  const upstream = playwrightShapeToUpstreamUrl(p);
  const localUrl = await proxyChain.anonymizeProxy(upstream);
  return {
    proxy: { server: localUrl },
    teardown: async () => {
      try {
        await proxyChain.closeAnonymizedProxy(localUrl, true);
      } catch (_) {}
    },
  };
}

/**
 * Convierte { server, username, password } al URL upstream que entiende proxy-chain.
 */
function playwrightShapeToUpstreamUrl(p) {
  const raw = String(p.server).trim();
  const u = new URL(raw.includes('://') ? raw : `http://${raw}`);
  const hasAuth =
    (p.username != null && String(p.username) !== '') ||
    (p.password != null && String(p.password) !== '');

  if (u.protocol === 'socks5:' || u.protocol === 'socks4:') {
    const port = u.port || 1080;
    if (!hasAuth) return `${u.protocol}//${u.hostname}:${port}`;
    const user = encodeURIComponent(String(p.username || ''));
    const pass = encodeURIComponent(String(p.password !== undefined ? p.password : ''));
    const proto = u.protocol === 'socks4:' ? 'socks4' : 'socks5';
    return `${proto}://${user}:${pass}@${u.hostname}:${port}`;
  }

  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  if (!hasAuth) return `${u.protocol}//${u.hostname}:${port}`;
  const user = encodeURIComponent(String(p.username || ''));
  const pass = encodeURIComponent(String(p.password !== undefined ? p.password : ''));
  return `${u.protocol}//${user}:${pass}@${u.hostname}:${port}`;
}

/**
 * Playwright rechaza socks5+auth y es frágil con http+auth (normalizeProxySettings).
 * proxy-chain expone http://127.0.0.1:puerto sin auth → upstream con credenciales.
 * @returns {Promise<{ proxy: object|undefined, teardown: () => Promise<void> }>}
 */
async function prepareOxxoGasPlaywrightProxy() {
  const p = getPlaywrightProxyOxxoGas();
  if (!p) {
    return { proxy: undefined, teardown: async () => {} };
  }

  const hasAuth =
    (p.username != null && String(p.username) !== '') ||
    (p.password != null && String(p.password) !== '');
  if (!hasAuth) {
    return { proxy: p, teardown: async () => {} };
  }

  const upstream = playwrightShapeToUpstreamUrl(p);
  const localUrl = await proxyChain.anonymizeProxy(upstream);
  return {
    proxy: { server: localUrl },
    teardown: async () => {
      try {
        await proxyChain.closeAnonymizedProxy(localUrl, true);
      } catch (_) {}
    },
  };
}

const { SocksProxyAgent } = require('socks-proxy-agent');

function getSocksAgent() {
  const url = process.env.PROXY_URL_SOCKS5;
  if (!url) return undefined;
  return new SocksProxyAgent(url);
}

module.exports = {
  getProxyAgent,
  getPlaywrightProxy,
  getPlaywrightProxyOxxoTienda,
  getPlaywrightProxyOxxoGas,
  getPlaywrightProxySoriana,
  prepareOxxoGasPlaywrightProxy,
  prepareSorianaPlaywrightProxy,
  getSocksAgent,
};
