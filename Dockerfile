FROM mcr.microsoft.com/playwright:v1.58.2-noble

WORKDIR /app

# Build tools para better-sqlite3
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY src/ ./src/

RUN mkdir -p /app/data

ENV NODE_ENV=production
EXPOSE ${PORT:-3000}

CMD ["node", "server.js"]
