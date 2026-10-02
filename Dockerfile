# ===========================================
# Stage 1: Backend deps + build (if any)
# ===========================================
# Chainguard's -dev variant supplies npm for the build stages. The runtime also
# needs the git executable because the backend uses simple-git.
ARG NODE_IMAGE=cgr.dev/chainguard/node:latest-dev@sha256:c73a5061e27b54daadcd0175194a860986f026a40d8b7b77166e6af008ea503b
ARG RUNTIME_IMAGE=cgr.dev/chainguard/wolfi-base:latest@sha256:82d42999b1bc4b2aa724b442d300194901e64563efec75b3245e41f4c09fb6d2
ARG NPM_VERSION=12.0.2
ARG APK_REPOSITORY=https://apk.cgr.dev/chainguard

FROM ${NODE_IMAGE} AS backend-build
ARG NPM_VERSION

USER root
RUN npm install -g npm@${NPM_VERSION} \
    && hash -r
WORKDIR /app/backend

COPY backend/package*.json ./
RUN npm_config_maxsockets=4 npm ci --omit=dev --ignore-scripts --no-audit --no-fund --prefer-offline

COPY backend/ ./

# ===========================================
# Stage 2: Frontend (Angular) build only
# ===========================================
FROM ${NODE_IMAGE} AS frontend-build
ARG NPM_VERSION

USER root
RUN npm install -g npm@${NPM_VERSION} \
    && hash -r

WORKDIR /app/frontend

COPY frontend/package*.json ./
RUN npm_config_maxsockets=4 npm ci --ignore-scripts --legacy-peer-deps --no-audit --no-fund --prefer-offline

COPY frontend/ ./

RUN npm run build -- --configuration production

# ===========================================
# Stage 3: Chainguard/Wolfi runtime
# ===========================================
FROM ${RUNTIME_IMAGE} AS runtime
ARG APK_REPOSITORY

USER root
RUN printf '%s\n' "${APK_REPOSITORY}" > /etc/apk/repositories \
    && apk --timeout 60 upgrade --no-cache \
    && apk --timeout 60 add --no-cache \
        nodejs \
        git \
        ca-certificates-bundle \
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
