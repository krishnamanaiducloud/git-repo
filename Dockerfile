# ===========================================
# Stage 1: Backend deps + build (if any)
# ===========================================
# Chainguard's -dev variant supplies npm for the build stages. The runtime also
# needs the git executable because the backend uses simple-git.
ARG NODE_IMAGE=cgr.dev/chainguard/node:latest-dev@sha256:f6d993b56d7ed81f72deaf7409c79b36b1066582b93bf4fdb8e51f0a31243244
ARG RUNTIME_IMAGE=cgr.dev/chainguard/wolfi-base:latest@sha256:8509ee4351a2e501b7f98201f2e2642396e82020c61a589cacdcfe74b9de46c1
ARG NPM_VERSION=12.2.2
ARG APK_REPOSITORY=https://apk.cgr.dev/chainguard
ARG APK_DOWNLOAD_IMAGE=cgr.dev/chainguard/python:latest-dev@sha256:fe4dbb574f811d271ac002a3e0270659f69841738276ef2d0084323baf1d75df

FROM ${RUNTIME_IMAGE} AS runtime-base

FROM ${NODE_IMAGE} AS backend-build
ARG NPM_VERSION

USER root
RUN npm install -g npm@${NPM_VERSION} \
    && hash -r
WORKDIR /app/backend

COPY backend/package*.json ./
RUN npm_config_maxsockets=4 npm_config_fetch_timeout=30000 npm_config_fetch_retries=3 \
    npm_config_fetch_retry_mintimeout=1000 npm_config_fetch_retry_maxtimeout=10000 \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund --prefer-offline

COPY backend/ ./

# ===========================================
# Stage 2: Frontend (Angular) build only
# ===========================================
FROM ${NODE_IMAGE} AS frontend-build
ARG NPM_VERSION
ENV NG_BUILD_MAX_WORKERS=2

USER root
RUN npm install -g npm@${NPM_VERSION} \
    && hash -r

WORKDIR /app/frontend

COPY frontend/package*.json ./
RUN npm_config_maxsockets=4 npm ci --ignore-scripts --no-audit --no-fund --prefer-offline

COPY frontend/ ./

RUN npm run build -- --configuration production \
    && npm test

# ===========================================
# Stage 3: Chainguard/Wolfi runtime
# ===========================================
FROM ${APK_DOWNLOAD_IMAGE} AS runtime-packages
ARG APK_REPOSITORY
USER root
COPY --from=runtime-base /usr/lib/apk/db/installed /tmp/apk-root/usr/lib/apk/db/installed
COPY --from=runtime-base /etc/apk/world /tmp/apk-root/etc/apk/world
COPY --from=runtime-base /etc/apk/keys/ /etc/apk/keys/
COPY container/prepare-apk-repository.sh /usr/local/bin/prepare-apk-repository.sh
RUN --mount=type=cache,id=node-release-apks,target=/tmp/apks,sharing=locked \
    sh /usr/local/bin/prepare-apk-repository.sh "$APK_REPOSITORY" /tmp/apk-root \
      'glibc>=2.44-r8' nodejs git ca-certificates-bundle

FROM runtime-base AS runtime
ARG APK_REPOSITORY

USER root
RUN --mount=type=bind,from=runtime-packages,source=/runtime-repository,target=/runtime-repository \
    printf '%s\n' /runtime-repository > /etc/apk/repositories \
    && apk --no-network --no-progress add --no-cache $(cat /runtime-repository/constraints) \
    && glibc_version="$(awk '/^P:/ { package=$0 } /^V:/ && package == "P:glibc-2.44" { sub(/^V:/, ""); print; exit }' /usr/lib/apk/db/installed)" \
    && test -n "$glibc_version" \
    && glibc_comparison="$(apk version -t "$glibc_version" 2.44-r8)" \
    && test "$glibc_comparison" != '<' \
    && printf '%s\n' "$APK_REPOSITORY" > /etc/apk/repositories \
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

CMD ["node", "index.js"]
