# =============================================================
#  Nova - Build & Deploy to Cloud Run (legacy helper)
#
#  Usage:
#    powershell -ExecutionPolicy Bypass -File .\scripts\deploy.ps1
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

$ErrorActionPreference = "Continue"

. "$PSScriptRoot\config.ps1"

function Step($msg) { Write-Host ""; Write-Host "[STEP] $msg" -ForegroundColor Cyan }
function OK($msg)   { Write-Host "  OK: $msg" -ForegroundColor Green }
function Info($msg) { Write-Host "  -- $msg" -ForegroundColor Gray }
function Fail($msg) { Write-Host ""; Write-Host "[ERROR] $msg" -ForegroundColor Red; exit 1 }

if ($PROJECT_ID -eq "YOUR_PROJECT_ID") {
    Fail "Set PROJECT_ID in scripts\config.ps1 first."
}

function Secret-Exists($Name) {
    gcloud.cmd secrets describe $Name --project=$PROJECT_ID 2>$null | Out-Null
    return $LASTEXITCODE -eq 0
}

# ── Step 1: Build image via Cloud Build ───────────────────────────
Step "Building Docker image via Cloud Build"
$IMAGE_TAG = "${IMAGE_PATH}:latest"

$repoRoot = Join-Path $PSScriptRoot ".."
Push-Location $repoRoot
gcloud.cmd builds submit --tag $IMAGE_TAG --project=$PROJECT_ID --timeout=10m .
$buildExit = $LASTEXITCODE
Pop-Location

if ($buildExit -ne 0) { Fail "Cloud Build failed." }
OK "Image built and pushed: $IMAGE_TAG"

# ── Step 2: Assemble Cloud Run flags ──────────────────────────────
Step "Assembling deployment configuration"

$secretMappings = [System.Collections.Generic.List[string]]::new()

if (Secret-Exists "OPENAI_API_KEY") {
    $secretMappings.Add("OPENAI_API_KEY=OPENAI_API_KEY:latest")
    OK "OPENAI_API_KEY secret found"
}

if (Secret-Exists $SECRET_KEY_NAME) {
    $secretMappings.Add("SECRET_KEY=SECRET_KEY:latest")
    OK "SECRET_KEY secret found"
} else {
    Info "SECRET_KEY not in Secret Manager - sessions will reset on restart"
}

$cloudSqlFlag = $null
if ($WithCloudSQL -or (Secret-Exists $DB_URL_SECRET_NAME)) {
    $secretMappings.Add("DATABASE_URL=DATABASE_URL:latest")
    $cloudSqlFlag = $SQL_CONN
    OK "DATABASE_URL secret found - Cloud SQL will be used"
} else {
    Info "DATABASE_URL not set - using SQLite (ephemeral)"
}

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

# ── Step 3: Deploy to Cloud Run ───────────────────────────────────
Step "Deploying to Cloud Run: $SERVICE_NAME ($REGION)"

$deployArgs = @(
    "run", "deploy", $SERVICE_NAME,
    "--image=$IMAGE_TAG",
    "--platform=managed",
    "--region=$REGION",
    "--allow-unauthenticated",
    "--memory=1Gi",
    "--cpu=2",
    "--min-instances=1",
    "--max-instances=10",
    "--concurrency=40",
    "--timeout=300",
    "--project=$PROJECT_ID"
)

if ($secretsArg) {
    $deployArgs += "--set-secrets=$secretsArg"
}

if ($cloudSqlFlag) {
    $deployArgs += "--add-cloudsql-instances=$cloudSqlFlag"
}

gcloud.cmd @deployArgs
if ($LASTEXITCODE -ne 0) { Fail "Cloud Run deployment failed." }

# ── Print result ──────────────────────────────────────────────────
$serviceUrl = gcloud.cmd run services describe $SERVICE_NAME `
    --region=$REGION `
    --project=$PROJECT_ID `
    --format="value(status.url)"

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  Deploy complete!" -ForegroundColor Green
Write-Host "  Live URL: $serviceUrl" -ForegroundColor Green
if (Secret-Exists $GG_ID_SECRET) {
    Write-Host "  Google redirect URI: ${serviceUrl}/auth/google/callback" -ForegroundColor Yellow
}
if (Secret-Exists $GH_ID_SECRET) {
    Write-Host "  GitHub callback URL: ${serviceUrl}/auth/github/callback" -ForegroundColor Yellow
}
Write-Host "============================================================" -ForegroundColor Green
