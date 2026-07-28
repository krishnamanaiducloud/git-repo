# RepoForge

RepoForge is a self-service Angular 22 application and Node.js API for creating GitLab projects from approved templates. The browser and API are served by the same origin, so the same image works at `/` or at a configured path such as `/git-repo/`.

## Modern UI and runtime

- Standalone, zoneless Angular with signals, typed reactive forms, modern template control flow, and no Bootstrap, Material, remote-font, or icon-runtime dependency.
- Inline validation and recoverable request errors; no browser alerts or simulated completion percentage.
- Keyboard-visible focus, a skip link, live loading/error/success status, reduced-motion support, and responsive layouts.
- Relative API calls plus a trailing-slash redirect make hashed assets and API calls work behind an OpenShift Route or Istio prefix without rewriting.
- The Node API validates and limits request bodies, rate-limits project creation, accepts idempotency keys, redacts the GitLab token from errors, emits request IDs, and sends a restrictive CSP and other defensive headers.
- The API is stateless. Multiple replicas are supported; GitLab remains the system of record. A repeated request reaching different replicas can still race, so GitLab's private-project namespace/path uniqueness is the final duplicate guard. Enforce a global rate limit at the authenticated ingress when a replica-independent quota is required.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `GITLAB_TOKEN` | yes | GitLab token supplied through a Secret or external secret controller |
| `GITLAB_API_URL` | yes | HTTPS GitLab API v4 URL |
| `GITLAB_WEB_URL` | yes | HTTPS GitLab web/git origin |
| `TEMPLATE_REPO_PREFIX` | yes | HTTPS prefix containing approved template repositories |
| `NAMESPACE_MAP` | yes | JSON object mapping visible subgroup names to GitLab namespace IDs |
| `TEMPLATE_MAP` | yes | JSON object mapping generated template names to template IDs |
| `BASE_PATH` | no | `/` by default; use `/git-repo` for the supplied path overlays |
| `CREATE_RATE_LIMIT` | no | Per-pod create attempts per ten minutes; default `5` |
| `GITLAB_TIMEOUT_MS` | no | Outbound GitLab HTTP timeout; default `30000` |

`ALLOW_INSECURE_GITLAB=true` exists only for isolated local testing. Production configuration fails readiness when GitLab URLs are not HTTPS.

## Local validation

```bash
cd backend
npm ci
npm test

cd ../frontend
npm ci
npm run build
npm test
```

Run below `/git-repo`:

```bash
BASE_PATH=/git-repo \
GITLAB_TOKEN=development-only \
GITLAB_API_URL=https://gitlab.example.com/api/v4 \
GITLAB_WEB_URL=https://gitlab.example.com \
TEMPLATE_REPO_PREFIX=https://gitlab.example.com/approved-templates/ \
NAMESPACE_MAP='{"team-alpha":101}' \
TEMPLATE_MAP='{"embark-go-image":201}' \
node backend/index.js
```

Open `http://localhost:3000/git-repo/`. When `BASE_PATH=/`, open the origin root.

## OpenShift and Istio

The base manifests use a ClusterIP Service, two replicas, zero-downtime rolling updates, probes, resource bounds, a PDB, topology spreading, a read-only root filesystem, an ephemeral `/tmp`, dropped capabilities, `RuntimeDefault` seccomp, and no fixed UID. This is compatible with OpenShift's namespace-assigned arbitrary UID.

Create the runtime Secret with External Secrets, Sealed Secrets, Vault, or your platform's secret workflow. `k8s/secret.example.yaml` is documentation and must not be applied unchanged.

The OpenShift overlay is fail-closed behind an `oauth2-proxy` v7.15.3 sidecar. Register an OIDC client whose callback is the public `/git-repo/oauth2/callback` URL, then create `gitlab-repo-creator-oauth` from your secret manager. Required keys are shown in `k8s/openshift/oauth2-proxy-secret.example.yaml`; use one shared, randomly generated cookie secret for every replica. The Route targets only the proxy Service, while the application Service remains internal.

```bash
# Inspect portable resources
oc kustomize k8s/base

# OpenShift Route at https://platform.apps.example.com/git-repo/
oc apply -k k8s/openshift

# Istio VirtualService at the same path
oc apply -k k8s/istio
```

Before applying, replace the image, host, GitLab endpoints/maps, namespace, and—when different—the Istio gateway namespace/name. The NetworkPolicy permits the standard `openshift-ingress` and `istio-system` namespaces; update it if the gateway is elsewhere.

The Istio overlay explicitly requests sidecar injection and includes an `AuthorizationPolicy` that only accepts authenticated request principals. It requires a matching platform-managed `RequestAuthentication`/OIDC configuration; without one it intentionally denies traffic. The OpenShift Route terminates TLS and reaches only the OIDC proxy. Do not change it back to the application Service or add unauthenticated skip routes for this privileged repository-creation API.

The Route and VirtualService preserve `/git-repo`; they do not rewrite it. The application `BASE_PATH` must match that prefix. Requests to `/git-repo` are redirected to `/git-repo/` so relative assets resolve correctly.

## Operational endpoints

| Endpoint | Scope | Meaning |
| --- | --- | --- |
| `/healthz` | pod root | process liveness |
| `/readyz` | pod root | listener is active and required GitLab/maps configuration is valid |
| `<BASE_PATH>/api/config/subgroups` | application | safe UI configuration |
| `<BASE_PATH>/api/create_repo` | application | repository creation |

Terminate TLS at the Route/gateway, keep the Service internal, protect all UI/API paths with SSO, and forward/generate `X-Request-Id` for trace correlation.
