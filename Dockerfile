# ===========================================
# Stage 1: Backend deps + build (if any)
# ===========================================
# Chainguard's -dev variant supplies npm for the build stages. The runtime also
# needs the git executable because the backend uses simple-git.
ARG NODE_IMAGE=cgr.dev/chainguard/node:latest-dev@sha256:446b1779a5c4b3d5aca6b05d77b5d7a643eef87b34ec6ba5dc55fd0c9f81a6aa
ARG RUNTIME_IMAGE=cgr.dev/chainguard/wolfi-base:latest@sha256:bef0f4d47edc72a93d1537eae54eb53db2b2cc352c028128ff0f16c5b5a3c1e4
ARG NPM_VERSION=12.1.0
ARG APK_REPOSITORY=https://packages.wolfi.dev/os
ARG WOLFI_REPO_DIGEST=f0031424cf46f7db780ce63a45f0fd6aa6f85f601e6bb3b7a91fe3d4d5b7d2cc

FROM ${NODE_IMAGE} AS backend-build
ARG NPM_VERSION
ARG APK_REPOSITORY
ARG WOLFI_REPO_DIGEST

USER root
COPY wolfi-signing.rsa.pub /tmp/wolfi-signing.rsa.pub
RUN echo "${WOLFI_REPO_DIGEST}  /tmp/wolfi-signing.rsa.pub" | sha256sum -c - \
    && mv /tmp/wolfi-signing.rsa.pub /etc/apk/keys/wolfi-signing.rsa.pub \
    && printf '%s\n' "${APK_REPOSITORY}" > /etc/apk/repositories \
    && apk upgrade --no-cache \
    && npm install -g npm@${NPM_VERSION}
WORKDIR /app/backend

COPY backend/package*.json ./
RUN npm_config_maxsockets=4 npm ci --omit=dev --ignore-scripts --no-audit --no-fund --prefer-offline

COPY backend/ ./

# ===========================================
# Stage 2: Frontend (Angular) build only
# ===========================================
FROM ${NODE_IMAGE} AS frontend-build
ARG NPM_VERSION
ARG APK_REPOSITORY
ARG WOLFI_REPO_DIGEST

USER root
COPY wolfi-signing.rsa.pub /tmp/wolfi-signing.rsa.pub
RUN echo "${WOLFI_REPO_DIGEST}  /tmp/wolfi-signing.rsa.pub" | sha256sum -c - \
    && mv /tmp/wolfi-signing.rsa.pub /etc/apk/keys/wolfi-signing.rsa.pub \
    && printf '%s\n' "${APK_REPOSITORY}" > /etc/apk/repositories \
    && apk upgrade --no-cache \
    && npm install -g npm@${NPM_VERSION}

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
    && apk upgrade --no-cache \
    && apk add --no-cache \
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
