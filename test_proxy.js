require('dotenv').config();
const axios = require('axios');
const { getProxyAgent } = require('./src/proxyAgent');

async function main() {
  console.log('--- Test 1: Sin proxy ---');
  const sinProxy = await axios.get('https://api.ipify.org?format=json');
  console.log('IP Railway/local:', sinProxy.data.ip);

  const agent = getProxyAgent('rotating');
  if (!agent) {
    console.log('⚠️  PROXY_URL_ROTATING no configurado en .env — agrega las variables');
    return;
  }

  console.log('\n--- Test 2: Con proxy rotating ---');
  const conProxy = await axios.get('https://api.ipify.org?format=json', {
    httpsAgent: agent, httpAgent: agent,
  });
  console.log('IP residencial:', conProxy.data.ip);
  console.log(sinProxy.data.ip !== conProxy.data.ip ? '✅ IPs distintas — proxy funcionando' : '❌ Misma IP — revisar credenciales');

  console.log('\n--- Test 3: Ping a 7-Eleven (misma base que src/portales/7eleven.js) ---');
  const portalUrl =
    process.env.SEVENELEVEN_BASE_URL || 'https://www.e7-eleven.com.mx';
  const test7 = await axios.get(`${portalUrl}/facturacion/KPortalExterno/`, {
    httpsAgent: agent,
    httpAgent: agent,
    validateStatus: () => true,
    headers: {
      Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
      'User-Agent':
        process.env.SEVENELEVEN_UA ||
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    },
  });
  const ok = test7.status >= 200 && test7.status < 400;
  const blocked = [401, 403, 429].includes(test7.status);
  const hint = blocked
    ? '❌ bloqueado (WAF / IP)'
    : ok
      ? '✅ respuesta OK'
      : `⚠️ status ${test7.status} (404 suele ser URL mal armada; 403/429 es bloqueo)`;
  console.log('Status 7-Eleven:', test7.status, hint);
}

main().catch(console.error);
