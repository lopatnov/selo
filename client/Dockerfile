# syntax=docker/dockerfile:1

# ---------- build ----------
FROM node:24-alpine AS build
WORKDIR /app
ARG REACT_APP_API_URL=http://localhost:3001/api
ENV REACT_APP_API_URL=$REACT_APP_API_URL \
    CI=true \
    GENERATE_SOURCEMAP=false
COPY client/package.json client/package-lock.json ./
RUN npm ci && npm cache clean --force
COPY client/ ./
RUN npm run build

# ---------- runtime ----------
FROM nginx:alpine AS runtime
COPY client/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/build /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
