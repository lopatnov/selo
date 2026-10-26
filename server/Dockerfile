# syntax=docker/dockerfile:1

# ---------- dependencies ----------
FROM node:24-alpine AS deps
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---------- runtime ----------
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3001
RUN apk add --no-cache tini curl
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
RUN mkdir -p /app/server/data && chown -R node:node /app
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/index.js"]
