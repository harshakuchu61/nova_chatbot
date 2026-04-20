# =============================================================
#  Nova - GitHub Actions x GCP Setup (Workload Identity)
#
#  Run ONCE to provision keyless authentication between
#  GitHub Actions and your GCP project. No SA JSON key is
#  ever created or stored.
#
#  Prerequisites:
#    1. gcloud CLI installed & logged in  (gcloud.cmd auth login)
#    2. config.ps1 has your real PROJECT_ID
#    3. Run from the repo root:
#         powershell -ExecutionPolicy Bypass -File .\scripts\setup-gha.ps1
# =============================================================

param(
    [string]$GitHubOwner  = "harshakuchu61",
    [string]$GitHubRepo   = "nova_chatbot",
    [string]$PoolName     = "github-pool",
    [string]$ProviderName = "github-provider",
    [string]$SaName       = "github-actions-sa"
)

$ErrorActionPreference = "Continue"

. "$PSScriptRoot\config.ps1"

if ($PROJECT_ID -eq "YOUR_PROJECT_ID") {
    Write-Host "ERROR: Edit scripts/config.ps1 and set PROJECT_ID before running this script." -ForegroundColor Red
    exit 1
}

$SA_EMAIL = "$SaName@$PROJECT_ID.iam.gserviceaccount.com"

Write-Host ""
Write-Host "[1/6] Enabling required APIs..." -ForegroundColor Cyan
gcloud.cmd services enable `
    iamcredentials.googleapis.com `
    cloudresourcemanager.googleapis.com `
    --project=$PROJECT_ID

# -- Workload Identity Pool ----------------------------------------
Write-Host "[2/6] Creating Workload Identity Pool '$PoolName'..." -ForegroundColor Cyan
gcloud.cmd iam workload-identity-pools describe $PoolName --location=global --project=$PROJECT_ID 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    gcloud.cmd iam workload-identity-pools create $PoolName `
        --location=global `
        --display-name="GitHub Actions Pool" `
        --project=$PROJECT_ID
} else {
    Write-Host "  Pool already exists, skipping."
}

# -- OIDC Provider -------------------------------------------------
Write-Host "[3/6] Creating OIDC provider '$ProviderName'..." -ForegroundColor Cyan
gcloud.cmd iam workload-identity-pools providers describe $ProviderName `
    --location=global --workload-identity-pool=$PoolName `
    --project=$PROJECT_ID 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    $attrMap = "google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner"
    $attrCond = "assertion.repository_owner == '$GitHubOwner'"
    gcloud.cmd iam workload-identity-pools providers create-oidc $ProviderName `
        --location=global `
        --workload-identity-pool=$PoolName `
        --issuer-uri="https://token.actions.githubusercontent.com" `
        --attribute-mapping=$attrMap `
        --attribute-condition=$attrCond `
        --display-name="GitHub OIDC Provider" `
        --project=$PROJECT_ID
} else {
    Write-Host "  Provider already exists, skipping."
}

# -- Service Account -----------------------------------------------
Write-Host "[4/6] Creating service account '$SaName'..." -ForegroundColor Cyan
gcloud.cmd iam service-accounts describe $SA_EMAIL --project=$PROJECT_ID 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    gcloud.cmd iam service-accounts create $SaName `
        --display-name="GitHub Actions Nova CI/CD" `
        --project=$PROJECT_ID
} else {
    Write-Host "  Service account already exists, skipping."
}

# -- IAM Roles -----------------------------------------------------
Write-Host "[5/6] Granting IAM roles to service account..." -ForegroundColor Cyan
$ROLES = @(
    "roles/run.admin",
    "roles/artifactregistry.writer",
    "roles/iam.serviceAccountUser",
    "roles/storage.admin"
)
foreach ($role in $ROLES) {
    gcloud.cmd projects add-iam-policy-binding $PROJECT_ID `
        --member="serviceAccount:$SA_EMAIL" `
        --role=$role `
        --condition=None | Out-Null
    Write-Host "  Granted: $role"
}

# -- WIF Binding ---------------------------------------------------
Write-Host "[6/6] Binding WIF pool to service account..." -ForegroundColor Cyan
$PROJECT_NUMBER = gcloud.cmd projects describe $PROJECT_ID --format="value(projectNumber)"
$WIF_POOL_RESOURCE = "projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$PoolName"
$MEMBER = "principalSet://iam.googleapis.com/$WIF_POOL_RESOURCE/attribute.repository/$GitHubOwner/$GitHubRepo"

gcloud.cmd iam service-accounts add-iam-policy-binding $SA_EMAIL `
    --project=$PROJECT_ID `
    --role="roles/iam.workloadIdentityUser" `
    --member=$MEMBER

# -- Output --------------------------------------------------------
$WIF_PROVIDER_FULL = "$WIF_POOL_RESOURCE/providers/$ProviderName"

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  Setup complete! Add these 3 secrets to GitHub:"            -ForegroundColor Green
Write-Host "  (repo Settings > Secrets and variables > Actions)"         -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  WIF_PROVIDER" -ForegroundColor Yellow
Write-Host "  $WIF_PROVIDER_FULL"
Write-Host ""
Write-Host "  WIF_SERVICE_ACCOUNT" -ForegroundColor Yellow
Write-Host "  $SA_EMAIL"
Write-Host ""
Write-Host "  GCP_PROJECT_ID" -ForegroundColor Yellow
Write-Host "  $PROJECT_ID"
Write-Host ""
Write-Host "  Also create a GitHub Environment named: production"        -ForegroundColor Green
Write-Host "  (repo Settings > Environments > New environment)"          -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
