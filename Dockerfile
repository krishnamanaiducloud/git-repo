# ================================
# Stage 1: Build (Node + npm lives here)
# ================================
FROM node:25.2.1-alpine3.22 AS build

# Fix BusyBox CVEs in build stage
RUN apk update && apk upgrade --no-cache

WORKDIR /app

# Backend deps
COPY backend/package*.json ./backend/
WORKDIR /app/backend
RUN npm ci --omit=dev

# Frontend deps + build
WORKDIR /app/frontend
COPY gitlab-repo-creator-frontend/package*.json ./
RUN npm ci
COPY gitlab-repo-creator-frontend/ ./
RUN npm run build

# Go back and copy backend source
WORKDIR /app/backend
COPY backend/ ./

# ================================
# Stage 2: Runtime (no npm, no node-pkg CVEs)
# ================================
FROM alpine:3.22

# Fix BusyBox CVEs in runtime
RUN apk update && apk upgrade --no-cache \
    && apk add --no-cache nodejs curl ca-certificates \
    && rm -rf /var/cache/apk/*

# IMPORTANT: we install only nodejs, NOT npm
# so no global npm tree → no node-pkg scanner hits on npm’s glob/tar.

WORKDIR /app/backend

# Copy built backend + frontend from build stage
COPY --from=build /app/backend ./
RUN mkdir -p ./public/browser
COPY --from=build /app/frontend/dist/gitlab-repo-creator-frontend/browser ./public/browser

# OpenShift-style permissions
RUN chgrp -R 0 /app && chmod -R g+rwX /app

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -f http://localhost:3000/api/config/subgroups || exit 1

CMD ["node", "index.js"]

