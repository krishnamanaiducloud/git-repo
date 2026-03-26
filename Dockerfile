# ===========================================
# Stage 1: Backend deps + build (if any)
# ===========================================
FROM node:25.8.1-alpine3.23 AS backend-build

# If you ever need native builds (bcrypt, etc.) uncomment below:
# RUN apk add --no-cache python3 make g++
RUN apk update && apk upgrade --no-cache
WORKDIR /app/backend

# Install ONLY prod dependencies for backend
COPY backend/package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# Copy backend source code
COPY backend/ ./
# If you have a build step (e.g. TypeScript), uncomment:
# RUN npm run build

# ===========================================
# Stage 2: Frontend (Angular) build only
# ===========================================
FROM node:25.8.1-alpine3.23 AS frontend-build
RUN apk update && apk upgrade --no-cache

WORKDIR /app/frontend

# Use lockfile so builds are repeatable and secure
COPY frontend/package*.json ./
RUN npm ci --ignore-scripts               # dev deps are OK here (build stage only)

# Copy the rest of the frontend
COPY frontend/ ./

# Build Angular app (browser build)
RUN npm run build -- --configuration production

# ===========================================
# Stage 3: Runtime image (Distroless - Production)
# ===========================================
FROM gcr.io/distroless/nodejs24-debian13:nonroot
#FROM gcr.io/distroless/nodejs24-debian12:nonroot

# Set environment variables
ENV NODE_ENV=production \
    PORT=3000 \
    PATH=/nodejs/bin:$PATH

# App will live here
WORKDIR /app/backend

# ---- Copy backend runtime (code + prod node_modules) ----
COPY --from=backend-build --chown=nonroot:nonroot /app/backend /app/backend

# ---- Copy Angular build output (STATIC files only) ----
COPY --from=frontend-build --chown=nonroot:nonroot /app/frontend/dist/frontend/browser /app/backend/public/browser

# Distroless runs as nonroot (UID 65532) by default
# No need for explicit USER directive

EXPOSE 3000

# Distroless doesn't have shell or curl for healthcheck
# Health checks should be configured in Kubernetes deployment

# Start server
CMD ["index.js"]

