# ================================
# Stage 1: Build Angular + Backend
# ================================
FROM node:25.2.1-alpine3.22 AS build

RUN apk update && apk upgrade --no-cache

WORKDIR /app

# --------------------------
# Backend deps (has lockfile)
# --------------------------
COPY backend/package*.json ./backend/
WORKDIR /app/backend
RUN npm ci --omit=dev

# --------------------------
# Frontend build
# --------------------------
WORKDIR /app/frontend
COPY frontend/package.json ./

# FIX: frontend has NO package-lock.json → must use npm install
RUN npm install

COPY frontend/ ./

RUN npm run build -- --configuration production

# --------------------------
# Copy backend source
# --------------------------
WORKDIR /app/backend
COPY backend/ ./

# ================================
# Stage 2: Runtime
# ================================
FROM alpine:3.22

RUN apk update && apk upgrade --no-cache \
    && apk add --no-cache nodejs curl ca-certificates \
    && rm -rf /var/cache/apk/*

WORKDIR /app/backend

COPY --from=build /app/backend ./

RUN mkdir -p ./public/browser
COPY --from=build /app/frontend/dist/frontend/browser ./public/browser

RUN chgrp -R 0 /app && chmod -R g+rwX /app

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -f http://localhost:3000/api/config/subgroups || exit 1

CMD ["node", "index.js"]

