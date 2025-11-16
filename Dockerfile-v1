# Stage 1: build frontend
FROM node:18-alpine AS frontend-build
WORKDIR /app/frontend
COPY gitlab-repo-creator-frontend/package.json gitlab-repo-creator-frontend/package-lock.json* ./
RUN npm install -g @angular/cli@19.1.5 && npm ci || npm install
COPY gitlab-repo-creator-frontend/ ./
RUN ng build --configuration production

# Stage 2: build backend
FROM node:18-alpine AS backend-build
WORKDIR /app/backend
# Install git for simple-git
RUN apk add --no-cache git
COPY backend/package.json backend/package-lock.json* ./
RUN npm ci || npm install
COPY backend/ ./

# Final stage: serve backend + frontend
FROM node:18-alpine
WORKDIR /app

# Install git in final stage as well, since simple-git runs at runtime in index.js
RUN apk add --no-cache git

# Create non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

# Copy frontend build output
COPY --from=frontend-build /app/frontend/dist/gitlab-repo-creator-frontend /app/public

# Copy backend code
COPY --from=backend-build /app/backend /app

# Expose port
EXPOSE 3000

# Start backend server
CMD ["npm", "start"]

