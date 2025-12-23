# ===========================================
# Stage 1: Backend deps + build (if any)
# ===========================================
FROM node:25.2.1-alpine3.23 AS backend-build

# If you ever need native builds (bcrypt, etc.) uncomment below:
# RUN apk add --no-cache python3 make g++

WORKDIR /app/backend

# Install ONLY prod dependencies for backend
COPY backend/package*.json ./
RUN npm ci --omit=dev

# Copy backend source code
COPY backend/ ./
# If you have a build step (e.g. TypeScript), uncomment:
# RUN npm run build

# ===========================================
# Stage 2: Frontend (Angular) build only
# ===========================================
FROM node:25.2.1-alpine3.23 AS frontend-build

WORKDIR /app/frontend

# Use lockfile so builds are repeatable and secure
COPY frontend/package*.json ./
RUN npm ci               # dev deps are OK here (build stage only)

# Copy the rest of the frontend
COPY frontend/ ./

# Build Angular app (browser build)
RUN npm run build -- --configuration production

# ===========================================
# Stage 3: Runtime image (what runs in OpenShift)
# ===========================================
FROM node:25.2.1-alpine3.23

# Only the tools needed at runtime
RUN apk update && apk upgrade --no-cache \
    && apk add --no-cache git openssh curl ca-certificates \
    && rm -rf /var/cache/apk/*

# App will live here
WORKDIR /app/backend

# ---- Copy backend runtime (code + prod node_modules) ----
COPY --from=backend-build /app/backend /app/backend

# ---- Copy Angular build output (STATIC files only) ----
RUN mkdir -p /app/backend/public/browser
COPY --from=frontend-build /app/frontend/dist/frontend/browser /app/backend/public/browser
RUN rm -rf /app/frontend /app/node_module /root/.npm /usr/local/lib/node_modules
# ---- OpenShift arbitrary UID compatibility ----
# - Give group 0 (root group) ownership
# - Make group writable so random UID in group 0 can write
RUN chgrp -R 0 /app && chmod -R g+rwX /app

# (Optional but common for OpenShift) - don't hardcode USER,
# OpenShift will inject a random UID in group 0.
# If you really want to set one:
# USER 1001

# ---------
# ENV Vars
# ---------
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# ---------------------------
# HEALTHCHECK
# ---------------------------
# Make sure your backend has:
#   app.get('/healthz', (req, res) => res.send('ok'));
#
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -f http://localhost:3000/healthz || exit 1

# Start server
CMD ["node", "index.js"]

