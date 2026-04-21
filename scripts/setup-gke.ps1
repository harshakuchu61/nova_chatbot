# =============================================================
#  Nova — GKE Autopilot Cluster Setup
#  Run once to provision the GKE cluster and supporting infra.
#  Prerequisites: gcloud CLI authenticated, kubectl installed.
# =============================================================

. "$PSScriptRoot\config.ps1"

$GKE_CLUSTER  = "nova-cluster"
$GKE_REGION   = $REGION
$K8S_NS       = "nova"
$GCP_SA       = "nova-sa"
$K8S_SA       = "nova-ksa"
$STATIC_IP    = "nova-ip"
$K8S_DIR      = "$PSScriptRoot\..\infra\k8s"

Write-Host "`n=== Nova — GKE Setup ===" -ForegroundColor Cyan

# ── 1. Enable required APIs ──────────────────────────────────
Write-Host "`n[1/9] Enabling GCP APIs..." -ForegroundColor Yellow
gcloud services enable `
    container.googleapis.com `
    secretmanager.googleapis.com `
    sqladmin.googleapis.com `
    artifactregistry.googleapis.com `
    --project=$PROJECT_ID

# ── 2. Create GKE Autopilot cluster ─────────────────────────
Write-Host "`n[2/9] Creating GKE Autopilot cluster '$GKE_CLUSTER'..." -ForegroundColor Yellow
gcloud container clusters create-auto $GKE_CLUSTER `
    --region=$GKE_REGION `
    --project=$PROJECT_ID `
    --workload-pool="${PROJECT_ID}.svc.id.goog"

# ── 3. Configure kubectl ─────────────────────────────────────
Write-Host "`n[3/9] Fetching cluster credentials..." -ForegroundColor Yellow
gcloud container clusters get-credentials $GKE_CLUSTER `
    --region=$GKE_REGION `
    --project=$PROJECT_ID

# ── 4. Reserve a global static IP ───────────────────────────
Write-Host "`n[4/9] Reserving static external IP '$STATIC_IP'..." -ForegroundColor Yellow
gcloud compute addresses create $STATIC_IP `
    --global `
    --project=$PROJECT_ID
$IP_ADDR = (gcloud compute addresses describe $STATIC_IP --global --project=$PROJECT_ID --format="value(address)")
Write-Host "  Static IP: $IP_ADDR  — point your DNS A record here." -ForegroundColor Green

# ── 5. Create GCP service account (if not already present) ──
Write-Host "`n[5/9] Ensuring GCP service account '$GCP_SA'..." -ForegroundColor Yellow
$SA_EMAIL = "${GCP_SA}@${PROJECT_ID}.iam.gserviceaccount.com"
$existing = gcloud iam service-accounts list --project=$PROJECT_ID --filter="email:$SA_EMAIL" --format="value(email)" 2>$null
if (-not $existing) {
    gcloud iam service-accounts create $GCP_SA `
        --display-name="Nova App Service Account" `
        --project=$PROJECT_ID
}
# Grant required roles
foreach ($role in @(
    "roles/secretmanager.secretAccessor",
    "roles/cloudsql.client",
    "roles/artifactregistry.reader"
)) {
    gcloud projects add-iam-policy-binding $PROJECT_ID `
        --member="serviceAccount:$SA_EMAIL" `
        --role=$role --quiet
}

# ── 6. Apply Kubernetes manifests ───────────────────────────
Write-Host "`n[6/9] Applying Kubernetes manifests..." -ForegroundColor Yellow
kubectl apply -f "$K8S_DIR\namespace.yaml"
kubectl apply -f "$K8S_DIR\serviceaccount.yaml"
kubectl apply -f "$K8S_DIR\deployment.yaml"
kubectl apply -f "$K8S_DIR\service.yaml"
kubectl apply -f "$K8S_DIR\hpa.yaml"

# ── 7. Bind Workload Identity ────────────────────────────────
Write-Host "`n[7/9] Binding Workload Identity (GCP SA ↔ K8s SA)..." -ForegroundColor Yellow
gcloud iam service-accounts add-iam-policy-binding $SA_EMAIL `
    --role="roles/iam.workloadIdentityUser" `
    --member="serviceAccount:${PROJECT_ID}.svc.id.goog[${K8S_NS}/${K8S_SA}]" `
    --project=$PROJECT_ID

# ── 8. Apply Ingress + TLS (after DNS is configured) ────────
Write-Host "`n[8/9] Applying Ingress and managed certificate..." -ForegroundColor Yellow
Write-Host "  NOTE: Edit infra/k8s/managed-cert.yaml with your domain first." -ForegroundColor DarkYellow
Write-Host "  Press Enter to apply now, or Ctrl+C to skip and apply later." -ForegroundColor DarkYellow
Read-Host
kubectl apply -f "$K8S_DIR\managed-cert.yaml"
kubectl apply -f "$K8S_DIR\ingress.yaml"

# ── 9. Summary ───────────────────────────────────────────────
Write-Host "`n=== Setup Complete ===" -ForegroundColor Green
Write-Host "Cluster  : $GKE_CLUSTER ($GKE_REGION)" -ForegroundColor Cyan
Write-Host "Static IP: $IP_ADDR  → point DNS here" -ForegroundColor Cyan
Write-Host "Check pod status: kubectl get pods -n nova" -ForegroundColor Cyan
Write-Host "Check ingress   : kubectl get ingress -n nova" -ForegroundColor Cyan
