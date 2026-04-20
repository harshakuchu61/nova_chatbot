# =============================================================
#  Nova — GitHub Actions × GCP Setup (Workload Identity)
#
#  Run ONCE to provision keyless authentication between
#  GitHub Actions and your GCP project.  No SA JSON key is
#  ever created or stored.
#
#  Prerequisites:
#    1. gcloud CLI installed & logged in  (gcloud auth login)
#    2. config.ps1 has your real PROJECT_ID
#    3. Run from the repo root:
#         .\scripts\setup-gha.ps1 -GitHubOwner "your-username"
# =============================================================

param(
    [string]$GitHubOwner  = "harshakuchu61",
    [string]$GitHubRepo   = "nova_chatbot",
    [string]$PoolName     = "github-pool",
    [string]$ProviderName = "github-provider",
    [string]$SaName       = "github-actions-sa"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. "$PSScriptRoot\config.ps1"

if ($PROJECT_ID -eq "YOUR_PROJECT_ID") {
    Write-Error "Edit scripts/config.ps1 and set `$PROJECT_ID before running this script."
}

$SA_EMAIL = "$SaName@$PROJECT_ID.iam.gserviceaccount.com"

Write-Host "`n[1/6] Enabling required APIs..." -ForegroundColor Cyan
gcloud services enable `
    iamcredentials.googleapis.com `
    cloudresourcemanager.googleapis.com `
    --project=$PROJECT_ID

# ── Workload Identity Pool ─────────────────────────────────
Write-Host "`n[2/6] Creating Workload Identity Pool '$PoolName'..." -ForegroundColor Cyan
$existingPool = gcloud iam workload-identity-pools describe $PoolName `
    --location=global --project=$PROJECT_ID 2>$null
if (-not $existingPool) {
    gcloud iam workload-identity-pools create $PoolName `
        --location=global `
        --display-name="GitHub Actions Pool" `
        --project=$PROJECT_ID
} else {
    Write-Host "  Pool already exists, skipping."
}

# ── OIDC Provider ──────────────────────────────────────────
Write-Host "`n[3/6] Creating OIDC provider '$ProviderName'..." -ForegroundColor Cyan
$existingProvider = gcloud iam workload-identity-pools providers describe $ProviderName `
    --location=global `
    --workload-identity-pool=$PoolName `
    --project=$PROJECT_ID 2>$null
if (-not $existingProvider) {
    gcloud iam workload-identity-pools providers create-oidc $ProviderName `
        --location=global `
        --workload-identity-pool=$PoolName `
        --issuer-uri="https://token.actions.githubusercontent.com" `
        --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" `
        --attribute-condition="assertion.repository_owner == '$GitHubOwner'" `
        --display-name="GitHub OIDC Provider" `
        --project=$PROJECT_ID
} else {
    Write-Host "  Provider already exists, skipping."
}

# ── Service Account ────────────────────────────────────────
Write-Host "`n[4/6] Creating service account '$SaName'..." -ForegroundColor Cyan
$existingSa = gcloud iam service-accounts describe $SA_EMAIL --project=$PROJECT_ID 2>$null
if (-not $existingSa) {
    gcloud iam service-accounts create $SaName `
        --display-name="GitHub Actions — Nova CI/CD" `
        --project=$PROJECT_ID
} else {
    Write-Host "  Service account already exists, skipping."
}

# ── IAM Roles ──────────────────────────────────────────────
Write-Host "`n[5/6] Granting IAM roles to service account..." -ForegroundColor Cyan
$ROLES = @(
    "roles/run.admin",                  # deploy to Cloud Run
    "roles/artifactregistry.writer",    # push Docker images
    "roles/iam.serviceAccountUser",     # act as Cloud Run SA
    "roles/storage.admin"               # staging bucket for builds
)
foreach ($role in $ROLES) {
    gcloud projects add-iam-policy-binding $PROJECT_ID `
        --member="serviceAccount:$SA_EMAIL" `
        --role=$role `
        --condition=None | Out-Null
    Write-Host "  Granted: $role"
}

# ── WIF Binding ────────────────────────────────────────────
Write-Host "`n[6/6] Binding WIF pool to service account..." -ForegroundColor Cyan
$PROJECT_NUMBER = gcloud projects describe $PROJECT_ID --format="value(projectNumber)"
$WIF_POOL_RESOURCE = "projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$PoolName"

gcloud iam service-accounts add-iam-policy-binding $SA_EMAIL `
    --project=$PROJECT_ID `
    --role="roles/iam.workloadIdentityUser" `
    --member="principalSet://iam.googleapis.com/$WIF_POOL_RESOURCE/attribute.repository/$GitHubOwner/$GitHubRepo"

# ── Output ─────────────────────────────────────────────────
$WIF_PROVIDER_FULL = "$WIF_POOL_RESOURCE/providers/$ProviderName"

Write-Host @"

╔══════════════════════════════════════════════════════════════╗
║  Setup complete!  Add these 3 secrets to your GitHub repo:   ║
║  (Settings → Secrets and variables → Actions → New secret)   ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  WIF_PROVIDER                                                ║
║  $WIF_PROVIDER_FULL
║                                                              ║
║  WIF_SERVICE_ACCOUNT                                         ║
║  $SA_EMAIL
║                                                              ║
║  GCP_PROJECT_ID                                              ║
║  $PROJECT_ID
║                                                              ║
╠══════════════════════════════════════════════════════════════╣
║  Also create a GitHub Environment named "production":         ║
║  Settings → Environments → New environment → production      ║
║  (optional: add required reviewers for deploy approval)      ║
╚══════════════════════════════════════════════════════════════╝
"@ -ForegroundColor Green
