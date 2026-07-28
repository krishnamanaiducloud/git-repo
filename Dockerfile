# ===========================================
# Stage 1: Backend deps + build (if any)
# ===========================================
ARG NODE_IMAGE=node:24.18.0-alpine3.24@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd
ARG NPM_VERSION=12.0.1

FROM ${NODE_IMAGE} AS backend-build
ARG NPM_VERSION

RUN apk upgrade --no-cache \
    && npm install -g npm@${NPM_VERSION}
WORKDIR /app/backend

COPY backend/package*.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY backend/ ./

# ===========================================
# Stage 2: Frontend (Angular) build only
# ===========================================
FROM ${NODE_IMAGE} AS frontend-build
ARG NPM_VERSION

RUN apk upgrade --no-cache \
    && npm install -g npm@${NPM_VERSION}

WORKDIR /app/frontend

COPY frontend/package*.json ./
RUN npm ci --ignore-scripts

COPY frontend/ ./

RUN npm run build -- --configuration production

# ===========================================
# Stage 3: Runtime image (Alpine - Production)
# ===========================================
FROM ${NODE_IMAGE} AS runtime

RUN apk upgrade --no-cache \
    && apk add --no-cache \
        c-ares \
        git \
        ca-certificates \
    && update-ca-certificates \
    && (apk del --no-cache vim vim-common xxd 2>/dev/null || true) \
    && rm -rf /opt/yarn \
             /opt/yarn-v* \
             /usr/local/lib/node_modules/npm \
             /usr/local/bin/npm \
             /usr/local/bin/npx \
             /usr/local/bin/corepack \
             /usr/local/bin/yarn \
             /usr/local/bin/yarnpkg

ENV HOME=/tmp \
    TMPDIR=/tmp \
    NODE_ENV=production \
    PORT=3000

WORKDIR /app/backend

COPY --from=backend-build /app/backend /app/backend

RUN mkdir -p /app/backend/public/browser
COPY --from=frontend-build /app/frontend/dist/frontend/browser /app/backend/public/browser

RUN rm -rf /app/frontend /root/.npm /usr/local/lib/node_modules

RUN chgrp -R 0 /app \
    && chmod -R g+rX /app \
    && chmod -R a-w /app

RUN addgroup -g 1001 appuser && \
    adduser -D -u 1001 -G appuser appuser && \
    adduser appuser root

USER 1001:0

EXPOSE 3000

STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "index.js"]

