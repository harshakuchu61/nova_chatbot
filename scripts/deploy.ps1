# =============================================================
#  Nova — Build & Deploy to Cloud Run
#
#  Usage:
#    .\scripts\deploy.ps1                        # standard redeploy
#    .\scripts\deploy.ps1 -WithCloudSQL $true    # called by setup.ps1
#
#  What it does:
#    1. Builds the Docker image via Cloud Build (no local Docker needed)
#    2. Pushes image to Artifact Registry
#    3. Deploys to Cloud Run with all secrets + Cloud SQL connection
# =============================================================

param(
    [bool]$WithCloudSQL = $false,
    [bool]$WithGoogle   = $false,
    [bool]$WithGitHub   = $false
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. "$PSScriptRoot\config.ps1"

function Step($msg) { Write-Host "`n[STEP] $msg" -ForegroundColor Cyan }
function OK($msg)   { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Info($msg) { Write-Host "  · $msg" -ForegroundColor Gray }
function Fail($msg) { Write-Host "`n[ERROR] $msg" -ForegroundColor Red; exit 1 }

if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
    Fail "gcloud CLI not found."
}
if ($PROJECT_ID -eq "YOUR_PROJECT_ID") {
    Fail "Set PROJECT_ID in scripts\config.ps1 first."
}

# Detect which secrets are already in Secret Manager
function Secret-Exists($Name) {
    gcloud secrets describe $Name --project=$PROJECT_ID 2>$null | Out-Null
    return $LASTEXITCODE -eq 0
}

# ── Step 1: Build image via Cloud Build ───────────────────────
Step "Building Docker image via Cloud Build"
$IMAGE_TAG = "${IMAGE_PATH}:latest"

Push-Location (Join-Path $PSScriptRoot "..")
try {
    gcloud builds submit `
        --tag $IMAGE_TAG `
        --project=$PROJECT_ID `
        --timeout=10m `
        .
    if ($LASTEXITCODE -ne 0) { Fail "Cloud Build failed." }
    OK "Image built and pushed: $IMAGE_TAG"
} finally {
    Pop-Location
}

# ── Step 2: Assemble Cloud Run flags ──────────────────────────
Step "Assembling Cloud Run deployment configuration"

# Always-required secrets
$secretMappings = [System.Collections.Generic.List[string]]::new()
$secretMappings.Add("OPENAI_API_KEY=OPENAI_API_KEY:latest")

if (Secret-Exists $SECRET_KEY_NAME) {
    $secretMappings.Add("SECRET_KEY=SECRET_KEY:latest")
    OK "SECRET_KEY secret found"
} else {
    Info "SECRET_KEY not in Secret Manager — sessions will reset on container restart"
    Info "Run setup.ps1 to fix this"
}

# Cloud SQL / database
$cloudSqlFlag = $null
if ($WithCloudSQL -or (Secret-Exists $DB_URL_SECRET_NAME)) {
    $secretMappings.Add("DATABASE_URL=DATABASE_URL:latest")
    $cloudSqlFlag = $SQL_CONN
    OK "DATABASE_URL secret found — Cloud SQL will be used"
} else {
    Info "DATABASE_URL not set — using SQLite (ephemeral, resets on restart)"
    Info "Run setup.ps1 to provision Cloud SQL"
}

# OAuth
if ($WithGoogle -or (Secret-Exists $GG_ID_SECRET)) {
    $secretMappings.Add("GOOGLE_CLIENT_ID=GOOGLE_CLIENT_ID:latest")
    $secretMappings.Add("GOOGLE_CLIENT_SECRET=GOOGLE_CLIENT_SECRET:latest")
    OK "Google OAuth secrets found"
}
if ($WithGitHub -or (Secret-Exists $GH_ID_SECRET)) {
    $secretMappings.Add("GITHUB_CLIENT_ID=GITHUB_CLIENT_ID:latest")
    $secretMappings.Add("GITHUB_CLIENT_SECRET=GITHUB_CLIENT_SECRET:latest")
    OK "GitHub OAuth secrets found"
}

$secretsArg = $secretMappings -join ","

# ── Step 3: Deploy ─────────────────────────────────────────────
Step "Deploying to Cloud Run: $SERVICE_NAME ($REGION)"

$deployArgs = @(
    "run", "deploy", $SERVICE_NAME,
    "--image=$IMAGE_TAG",
    "--platform=managed",
    "--region=$REGION",
    "--allow-unauthenticated",
    "--set-secrets=$secretsArg",
    "--memory=512Mi",
    "--cpu=1",
    "--min-instances=0",
    "--max-instances=10",
    "--timeout=120",
    "--project=$PROJECT_ID"
)

if ($cloudSqlFlag) {
    $deployArgs += "--add-cloudsql-instances=$cloudSqlFlag"
}

& gcloud @deployArgs
if ($LASTEXITCODE -ne 0) { Fail "Cloud Run deployment failed." }

# ── Print service URL ──────────────────────────────────────────
$serviceUrl = gcloud run services describe $SERVICE_NAME `
    --region=$REGION `
    --project=$PROJECT_ID `
    --format="value(status.url)"

Write-Host ""
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host "  Deploy complete!" -ForegroundColor Green
Write-Host "  Live URL: $serviceUrl" -ForegroundColor Green
if ($WithGoogle -or (Secret-Exists $GG_ID_SECRET)) {
    Write-Host "  Google redirect URI: ${serviceUrl}/google/authorized" -ForegroundColor Yellow
    Write-Host "  → Add this to your Google OAuth 2.0 Client's Authorised redirect URIs" -ForegroundColor Yellow
}
if ($WithGitHub -or (Secret-Exists $GH_ID_SECRET)) {
    Write-Host "  GitHub callback URL: ${serviceUrl}/github/authorized" -ForegroundColor Yellow
    Write-Host "  → Add this to your GitHub OAuth App's Authorization callback URL" -ForegroundColor Yellow
}
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Green
