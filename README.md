# GitLab Repo Creator

**Production-Ready GitLab Repository Automation with Angular + Node.js**

A full-stack web application that automates GitLab repository creation with a modern Angular frontend and Node.js backend. Built with production-grade security using distroless containers and deployed on Kubernetes/OpenShift.

---

## Overview

This application provides an intuitive web interface to automate GitLab repository creation by:

- **Creating GitLab repositories** from predefined templates
- **Managing namespace mappings** via ConfigMap
- **Handling template selection** based on technology and artifact type
- **Serving Angular UI** from Node.js backend with static file optimization
- **Supporting OpenShift** arbitrary UID and Istio routing

---

## Technology Stack

### Runtime
- **Node.js Build**: `25.8.1` (Alpine 3.23)
- **Production Runtime**: `gcr.io/distroless/nodejs24-debian12:nonroot` (Distroless - no shell, no package manager)
- **Debug Runtime**: `alpine:3.23.3` (with shell and debugging tools)

### Frontend (Angular 19)
| Package | Version | Purpose |
|---------|---------|---------|
| `@angular/core` | `^19.1.5` | Angular framework |
| `@angular/material` | `^19.1.3` | Material Design components |
| `@angular/cdk` | `^19.1.3` | Component Dev Kit |
| `bootstrap` | `^5.3.3` | CSS framework |
| `rxjs` | `~7.8.1` | Reactive programming |
| `typescript` | `~5.7.2` | TypeScript compiler |

### Backend (Node.js)
| Package | Version | Purpose |
|---------|---------|---------|
| `express` | `^4.21.2` | Web framework |
| `axios` | `^1.7.9` | HTTP client for GitLab API |
| `simple-git` | `^3.27.0` | Git operations |
| `dotenv` | `^16.4.7` | Environment configuration |
| `fs-extra` | `^11.2.0` | Enhanced file system operations |
| `glob` | `^11.0.0` | File pattern matching |
| `tar` | `^7.4.3` | Archive handling |

---

## Architecture

### Multi-Stage Docker Build
1. **Backend Build Stage**: Node.js 25.8.1 (Alpine 3.23) - Install production dependencies
2. **Frontend Build Stage**: Node.js 25.8.1 (Alpine 3.23) - Build Angular app
3. **Production Runtime**: Google Distroless (Debian 12) - Minimal, hardened, no shell/package manager
4. **Debug Runtime**: Alpine 3.23.3 with shell and debugging tools (Dockerfile-debug)

### Security Features
- **Distroless Runtime**: No shell, no package manager, minimal attack surface
- **Non-root User**: Runs as UID 65532 (nonroot) in production
- **Dependency Security**: `--ignore-scripts` flag prevents malicious post-install scripts
- **Multi-stage Build**: Separates build dependencies from runtime
- **Static Asset Optimization**: Angular production build with AOT compilation
- **OpenShift Compatible**: Group 0 permissions for OpenShift SCC compliance
- **Secret Management**: GitLab tokens stored in Kubernetes Secrets only

### High Availability
- **Configurable Replicas**: Kubernetes deployment supports multiple pods
- **Health Checks**: Kubernetes liveness and readiness probes
- **Static File Caching**: Optimized serving of Angular assets
- **Resource Limits**: CPU and memory constraints defined

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/create_repo` | Create new GitLab repository from template |
| `GET` | `/healthz` | Health check endpoint (debug image only) |
| `GET` | `/*` | Serve Angular SPA (fallback route) |

### Request Schema (`/api/create_repo`)
```json
{
  "projectName": "my-new-project",
  "subgroup": "team-name",
  "technology": "Java",
  "artifactType": "Service",
  "ownerInfo": "team@example.com"
}
```

---

## Deployment on Kubernetes/OpenShift

### Prerequisites
- Kubernetes/OpenShift cluster
- GitLab access token with repository creation permissions
- Namespace configured with appropriate RBAC

### Deployment Steps

1. **Create Namespace**
   ```bash
   kubectl create namespace gitlab-repo-creator
   # OR for OpenShift
   oc create namespace gitlab-repo-creator
   ```

2. **Apply ConfigMap**
   ```bash
   kubectl apply -f k8s/configmap.yaml
   ```
   Update the ConfigMap with:
   - `NAMESPACE_MAP`: JSON mapping of subgroups to GitLab namespace IDs
   - `TEMPLATE_MAP`: JSON mapping of template names to project IDs
   - `GITLAB_API_URL`: Your GitLab instance URL

3. **Create Secret**
   ```bash
   kubectl apply -f k8s/secret.yaml
   ```
   Add your `GITLAB_TOKEN` to the secret.

4. **Deploy Application**
   ```bash
   kubectl apply -f k8s/deployment.yaml
   kubectl apply -f k8s/service.yaml
   ```

5. **Access the Application**
   ```bash
   # Via NodePort
   http://<node-ip>:31000
   
   # Via OpenShift Route
   oc expose service gitlab-repo-creator
   
   # Via Istio VirtualService
   kubectl apply -f k8s/virtualservice.yaml
   ```

---

## Local Development

### Build Docker Images

**Production Image (Distroless)**
```bash
docker build -t gitlab-repo-creator:latest .
```

**Debug Image (with shell)**
```bash
docker build -f Dockerfile-debug -t gitlab-repo-creator:debug .
```

### Run Locally

**Production Image**
```bash
docker run -p 3000:3000 \
  -e GITLAB_API_URL=https://gitlab.example.com/api/v4 \
  -e GITLAB_TOKEN=your-token \
  -e NAMESPACE_MAP='{"team1":123,"team2":456}' \
  -e TEMPLATE_MAP='{"embark-java-service":789}' \
  gitlab-repo-creator:latest
```

**Debug Image (with shell access)**
```bash
docker run -p 3000:3000 \
  -e GITLAB_API_URL=https://gitlab.example.com/api/v4 \
  -e GITLAB_TOKEN=your-token \
  -e NAMESPACE_MAP='{"team1":123,"team2":456}' \
  -e TEMPLATE_MAP='{"embark-java-service":789}' \
  gitlab-repo-creator:debug
```

Access the UI at `http://localhost:3000`

**Note**: Distroless images don't have a shell, use the debug image for troubleshooting.

---

## Configuration

### Environment Variables
| Variable | Required | Description |
|----------|----------|-------------|
| `GITLAB_API_URL` | Yes | GitLab API endpoint (e.g., `https://gitlab.com/api/v4`) |
| `GITLAB_TOKEN` | Yes | GitLab personal access token with API access |
| `NAMESPACE_MAP` | Yes | JSON mapping of subgroup names to GitLab namespace IDs |
| `TEMPLATE_MAP` | Yes | JSON mapping of template names to GitLab project IDs |
| `TEMPLATE_REPO_PREFIX` | No | Base URL for template repositories |
| `PORT` | No | Server port (default: `3000`) |

### Example ConfigMap
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: gitlab-repo-creator-config
data:
  GITLAB_API_URL: "https://gitlab.example.com/api/v4"
  NAMESPACE_MAP: |
    {
      "team-alpha": 123,
      "team-beta": 456
    }
  TEMPLATE_MAP: |
    {
      "embark-java-service": 789,
      "embark-go-service": 790,
      "embark-ui-app": 791
    }
```

---

## Security Considerations

- **Distroless Runtime**: Production image has no shell or package manager, preventing shell-based attacks
- **Non-root Execution**: Runs as UID 65532 (nonroot) in production, UID 1001 in debug
- **Token Storage**: GitLab tokens must be stored in Kubernetes Secrets, never in ConfigMaps or code
- **Dependency Security**: `--ignore-scripts` prevents malicious npm post-install scripts
- **Static Asset Security**: Angular production build with AOT compilation and tree-shaking
- **OpenShift SCC**: Compatible with restricted security context constraints
- **No Secret Logging**: Sensitive data excluded from application logs

---

## Project Structure

```plaintext
git-repo/
├── backend/                        # Node.js backend
│   ├── index.js                   # Express server + GitLab API integration
│   └── package.json               # Backend dependencies
├── frontend/                       # Angular 19 frontend
│   ├── src/                       # Angular source code
│   ├── angular.json               # Angular configuration
│   └── package.json               # Frontend dependencies
├── k8s/                           # Kubernetes manifests
│   ├── configmap.yaml            # Configuration
│   ├── secret.yaml               # Secrets template
│   ├── deployment.yaml           # Deployment spec
│   └── service.yaml              # Service definition
├── Dockerfile                     # Production multi-stage build (distroless)
├── Dockerfile-debug              # Debug build (alpine with shell)
├── index.js                      # Alternative entrypoint
├── package.json                  # Root dependencies
└── README.md                     # This file
```

---

## Monitoring & Observability

- **Health Checks**: Configure Kubernetes liveness/readiness probes on `/healthz` (debug image)
- **Logging**: Structured logs to stdout for container log aggregation
- **Metrics**: Consider adding Prometheus metrics endpoint for monitoring
- **Tracing**: Request IDs for distributed tracing support

---

## Supported Technologies & Artifacts

Configure in `TEMPLATE_MAP` environment variable:
- **Java**: Service, Library, API
- **Go**: Service, CLI, Library
- **UI**: Angular, React, Vue
- **Python**: Service, Library, CLI

---

## Troubleshooting

### Build Issues
- Ensure `package-lock.json` files are in sync with `package.json`
- Run `npm install` in both `frontend/` and `backend/` directories
- Check Node.js version compatibility (25.8.1)

### Runtime Issues
- Verify GitLab token has correct permissions
- Check namespace and template IDs in ConfigMap
- Use debug image for shell access: `docker exec -it <container> sh`
- Review Kubernetes pod logs: `kubectl logs <pod-name>`

### OpenShift Specific
- Ensure group 0 permissions are set correctly
- Verify SCC allows arbitrary UIDs
- Check route/ingress configuration for proper path handling

---

## License

Internal use only.

---

## Maintainer

- **Author**: Mohan Krishna
- **Environment**: Kubernetes / OpenShift / Docker
- **Version**: 1.0.0
