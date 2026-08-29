# ===========================================
# Stage 1: Backend deps + build (if any)
# ===========================================
# Chainguard's -dev variant supplies npm for the build stages. The runtime also
# needs the git executable because the backend uses simple-git.
ARG NODE_IMAGE=cgr.dev/chainguard/node:latest-dev@sha256:c14f79235064d92d270d82939f52dfc6b68a9728771655857b885b62348532d1
ARG NPM_VERSION=12.0.2

FROM ${NODE_IMAGE} AS backend-build
ARG NPM_VERSION

USER root
RUN apk upgrade --no-cache \
    && npm install -g npm@${NPM_VERSION}
WORKDIR /app/backend

COPY backend/package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund --prefer-offline

COPY backend/ ./

# ===========================================
# Stage 2: Frontend (Angular) build only
# ===========================================
FROM ${NODE_IMAGE} AS frontend-build
ARG NPM_VERSION

USER root
RUN apk upgrade --no-cache \
    && npm install -g npm@${NPM_VERSION}

WORKDIR /app/frontend

COPY frontend/package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts --legacy-peer-deps --no-audit --no-fund --prefer-offline

COPY frontend/ ./

RUN npm run build -- --configuration production

# ===========================================
# Stage 3: Chainguard/Wolfi runtime
# ===========================================
FROM ${NODE_IMAGE} AS runtime

USER root
RUN apk upgrade --no-cache \
    && apk add --no-cache \
        git \
        ca-certificates-bundle \
    && apk del --no-cache npm \
    && rm -rf /root/.npm /var/cache/apk/*

ENV HOME=/tmp \
    TMPDIR=/tmp \
    NODE_ENV=production \
    PORT=3000

WORKDIR /app/backend

COPY --from=backend-build --chown=65532:0 /app/backend /app/backend

COPY --from=frontend-build --chown=65532:0 /app/frontend/dist/frontend/browser /app/backend/public/browser

USER 65532:0

EXPOSE 3000

STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "-e", "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]

CMD ["index.js"]
