#!/bin/bash
# Inyecta comando /testpetro7 en server.js automáticamente

FILE="$HOME/Documents/cotas-full-production, v1/server.js"

if [ ! -f "$FILE" ]; then
  echo "❌ No encontré $FILE"
  exit 1
fi

if grep -q "testpetro7" "$FILE"; then
  echo "⚠️  testpetro7 ya existe en server.js"
  exit 0
fi

cat >> "$FILE" << 'PATCH'

// TEMPORAL — diagnóstico de conectividad a portales
bot.command('testpetro7', async (ctx) => {
  await ctx.reply('⏳ Probando conexión a Petro 7...');
  try {
    const res = await axios.get('https://tarjetapetro-7.com.mx/KJServices/webapi/FacturacionService/verificaTicketWS2', {
      params: { estacion: '6131', noTicket: '2518259', webId: 'B62C', fechaTicket: '15/04/2026' },
      headers: {
        'accept': 'application/json, text/plain, */*',
        'referer': 'https://tarjetapetro-7.com.mx/KPortalExterno/',
        'origin': 'https://tarjetapetro-7.com.mx',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
      },
      timeout: 10000,
    });
    await ctx.reply('✅ ' + res.status + '\n' + JSON.stringify(res.data).substring(0, 500));
  } catch (e) {
    const status = e.response?.status || 'SIN RESPUESTA';
    const server = e.response?.headers?.['server'] || 'desconocido';
    const cf = e.response?.headers?.['cf-ray'] ? 'SÍ' : 'NO';
    await ctx.reply('❌ Status: ' + status + '\nServer: ' + server + '\nCloudflare: ' + cf + '\nError: ' + e.message);
  }
});
PATCH

echo "✅ Inyectado en $FILE"
echo ""
echo "Ahora corre:"
echo "  cd \"$HOME/Documents/cotas-full-production, v1\""
echo "  git add server.js && git commit -m 'diagnóstico petro7' && git push"
