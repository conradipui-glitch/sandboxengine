# Engine runtime hosting — node:24.19 (project engines >=24.19.0 <25)
FROM node:24.19-slim
RUN apt-get update && apt-get install -y --no-install-recommends git python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /engine
COPY . .
RUN npm ci --include=dev && npm run build && npm prune --omit=dev
ENV NODE_ENV=production LH_HOST=127.0.0.1 LH_PORT=8742
EXPOSE 8742
CMD ["node", "apps/server/dist/main.js"]
