# Imagen oficial Playwright (Chromium + dependencias del sistema para portales JSF).
# Debe coincidir la versión mayor con la de package-lock (playwright).
FROM mcr.microsoft.com/playwright:v1.58.2-noble

WORKDIR /app

# better-sqlite3 compila nativo
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# OXXO Gas: SOCKS5 con auth requiere Firefox (Chromium no lo soporta en Playwright).
RUN npx playwright install firefox

# SQLite y sesiones: en Railway conviene volumen en /data (ver src/dataDir.js)
RUN mkdir -p /data

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "server.js"]
