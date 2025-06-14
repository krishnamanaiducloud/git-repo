# 🚀 GitLab Repo Creator – Production Bundle

This project automates GitLab repository creation with a full-stack web interface built using Angular (frontend) and Node.js (backend). It's packaged into a production-ready Docker image and deployable to Kubernetes.

---

## 📦 Tech Stack

- **Frontend**: Angular (`gitlab-repo-creator-frontend`)
- **Backend**: Node.js (`backend/`)
- **Containerization**: Docker (Multi-stage build)
- **Deployment**: Kubernetes (via manifests in `k8s/` directory)

---

## 🔧 Setup & Deployment

### 1️⃣ Prepare the Frontend

```bash
ng new gitlab-repo-creator-frontend --strict --style=scss --routing=false
# Copy the following into src/app/:
# - app.component.ts
# - app.component.html
# - app.config.ts

cd gitlab-repo-creator-frontend
npm install
ng build --configuration production
```

### 2️⃣ Setup the Backend

```bash
cd backend
npm install
```

### 3️⃣ Build the Docker Image

```bash
cd ..
docker build -t your-docker-repo/gitlab-repo-creator:latest .
```

### 4️⃣ Deploy to Kubernetes

Apply the necessary Kubernetes objects:

```bash
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/secret.yaml
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
```

### 5️⃣ Access the Application

```plaintext
http://<node-ip>:31000
```

Replace `<node-ip>` with your actual Kubernetes node IP.

---

## 🔐 Security Highlights

- ✅ Runs as **non-root** user inside the container
- ✅ **Multi-stage Docker build** ensures minimal image size
- ✅ GitLab **token stored securely** via Kubernetes Secret
- ✅ **NamespaceMap** and **TemplateMap** injected via ConfigMap

---

## 📁 Project Structure

```plaintext
final/
├── backend/                        # Node.js backend
├── gitlab-repo-creator-frontend/  # Angular frontend
├── k8s/                            # Kubernetes manifests
├── Dockerfile                      # Multi-stage build
├── index.js                        # Optional backend entrypoint
├── README.md
└── .gitignore
```

---

## 🛠️ Maintainer

- **Author**: Mohan
- **Environment**: Linux / Docker / Kubernetes
