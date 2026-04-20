# =============================================================
#  Nova — One-Time GCP Auth + Database Setup
#  Run this ONCE after deploying the initial app.
#
#  What it does:
#    1. Enables Cloud SQL API
#    2. Generates SECRET_KEY → stores in Secret Manager
#    3. Prompts for optional OAuth credentials → Secret Manager
#    4. Creates a Cloud SQL PostgreSQL instance + DB + user
#    5. Stores DATABASE_URL in Secret Manager
#    6. Grants IAM roles to the Cloud Run service account
#    7. Calls deploy.ps1 to redeploy with all new secrets
#
#  Prerequisites:
#    - gcloud CLI installed and authenticated (gcloud auth login)
#    - PROJECT_ID set in config.ps1
#    - Original Cloud Run service already deployed (Phase 7 complete)
# =============================================================

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Load shared config
. "$PSScriptRoot\config.ps1"

# ── Helpers ────────────────────────────────────────────────────
function Step($msg) { Write-Host "`n[STEP] $msg" -ForegroundColor Cyan }
function OK($msg)   { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Info($msg) { Write-Host "  · $msg" -ForegroundColor Gray }
function Warn($msg) { Write-Host "  ⚠ $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "`n[ERROR] $msg" -ForegroundColor Red; exit 1 }

function Ensure-Secret($Name, $Value) {
    $exists = gcloud secrets describe $Name --project=$PROJECT_ID 2>$null
    if ($LASTEXITCODE -ne 0) {
        gcloud secrets create $Name `
            --project=$PROJECT_ID `
            --replication-policy="automatic" | Out-Null
        Info "Created secret '$Name'"
    }
    $Value | gcloud secrets versions add $Name `
        --project=$PROJECT_ID `
        --data-file=- | Out-Null
    OK "Stored secret '$Name'"
}

# ── Preflight ──────────────────────────────────────────────────
if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
    Fail "gcloud CLI not found. Install from https://cloud.google.com/sdk/docs/install"
}

if ($PROJECT_ID -eq "YOUR_PROJECT_ID") {
    Fail "Edit scripts\config.ps1 and set PROJECT_ID to your real GCP Project ID."
}

Step "Verifying project: $PROJECT_ID"
gcloud config set project $PROJECT_ID | Out-Null
OK "Project set to $PROJECT_ID"

# ── Enable APIs ────────────────────────────────────────────────
Step "Enabling required APIs"
$apis = @(
    "sqladmin.googleapis.com",
    "secretmanager.googleapis.com",
    "run.googleapis.com",
    "cloudbuild.googleapis.com"
)
foreach ($api in $apis) {
    gcloud services enable $api --project=$PROJECT_ID | Out-Null
    OK "Enabled $api"
}

# ── SECRET_KEY ─────────────────────────────────────────────────
Step "Generating SECRET_KEY"
$secretBytes = [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
$secretKey   = ($secretBytes | ForEach-Object { $_.ToString("x2") }) -join ""
Ensure-Secret $SECRET_KEY_NAME $secretKey
Info "Key: $($secretKey.Substring(0,8))... (truncated for security)"

# ── OAuth credentials (optional) ──────────────────────────────
Step "OAuth credentials (press Enter to skip)"
Write-Host "  Google Cloud Console: console.cloud.google.com → APIs & Services → Credentials" -ForegroundColor Gray
Write-Host "  Authorised redirect URI: https://<your-run-url>/google/authorized" -ForegroundColor Gray

$ggId  = Read-Host "  Google Client ID (blank to skip)"
$ggSec = Read-Host "  Google Client Secret (blank to skip)"
if ($ggId -and $ggSec) {
    Ensure-Secret $GG_ID_SECRET  $ggId
    Ensure-Secret $GG_SEC_SECRET $ggSec
    OK "Google OAuth credentials stored"
} else {
    Warn "Google OAuth skipped — users can still sign in with email/password"
}

Write-Host ""
Write-Host "  GitHub: github.com/settings/developers → New OAuth App" -ForegroundColor Gray
Write-Host "  Callback URL: https://<your-run-url>/github/authorized" -ForegroundColor Gray

$ghId  = Read-Host "  GitHub Client ID (blank to skip)"
$ghSec = Read-Host "  GitHub Client Secret (blank to skip)"
if ($ghId -and $ghSec) {
    Ensure-Secret $GH_ID_SECRET  $ghId
    Ensure-Secret $GH_SEC_SECRET $ghSec
    OK "GitHub OAuth credentials stored"
} else {
    Warn "GitHub OAuth skipped — users can still sign in with email/password"
}

# ── Cloud SQL ──────────────────────────────────────────────────
Step "Creating Cloud SQL PostgreSQL instance: $SQL_INSTANCE"
Info "This takes 5-10 minutes. Grab a coffee ☕"

$sqlExists = gcloud sql instances describe $SQL_INSTANCE --project=$PROJECT_ID 2>$null
if ($LASTEXITCODE -eq 0) {
    Warn "Instance '$SQL_INSTANCE' already exists — skipping creation"
} else {
    gcloud sql instances create $SQL_INSTANCE `
        --project=$PROJECT_ID `
        --database-version=POSTGRES_15 `
        --tier=db-f1-micro `
        --region=$REGION `
        --storage-type=SSD `
        --storage-size=10GB `
        --storage-auto-increase `
        --backup-start-time=03:00 `
        --no-assign-ip `
        --availability-type=zonal
    if ($LASTEXITCODE -ne 0) { Fail "Cloud SQL instance creation failed." }
    OK "Instance created"
}

Step "Creating database '$SQL_DATABASE' and user '$SQL_USER'"
# Create database
gcloud sql databases create $SQL_DATABASE `
    --instance=$SQL_INSTANCE `
    --project=$PROJECT_ID 2>$null | Out-Null

# Generate password and create user
$dbPasswordBytes = [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(24)
$dbPassword = [System.Convert]::ToBase64String($dbPasswordBytes) -replace '[+/=]', 'x'

gcloud sql users create $SQL_USER `
    --instance=$SQL_INSTANCE `
    --project=$PROJECT_ID `
    --password=$dbPassword 2>$null | Out-Null
OK "Database and user created"

# Build DATABASE_URL
$dbUrl = "postgresql+psycopg2://${SQL_USER}:${dbPassword}@/${SQL_DATABASE}?host=/cloudsql/${SQL_CONN}"
Ensure-Secret $DB_URL_SECRET_NAME $dbUrl
OK "DATABASE_URL stored in Secret Manager"

# ── IAM permissions for Cloud Run ─────────────────────────────
Step "Granting Cloud Run service account access to Cloud SQL and secrets"

# Get the Cloud Run service account (default: PROJECT_NUMBER-compute@developer.gserviceaccount.com)
$projectNumber = gcloud projects describe $PROJECT_ID --format="value(projectNumber)"
$runSA = "${projectNumber}-compute@developer.gserviceaccount.com"
Info "Cloud Run service account: $runSA"

# Cloud SQL Client role
gcloud projects add-iam-policy-binding $PROJECT_ID `
    --member="serviceAccount:$runSA" `
    --role="roles/cloudsql.client" | Out-Null
OK "Granted roles/cloudsql.client"

# Secret Manager accessor for each secret
$allSecrets = @(
    "OPENAI_API_KEY",
    $SECRET_KEY_NAME,
    $DB_URL_SECRET_NAME
)
if ($ggId)  { $allSecrets += $GG_ID_SECRET;  $allSecrets += $GG_SEC_SECRET }
if ($ghId)  { $allSecrets += $GH_ID_SECRET;  $allSecrets += $GH_SEC_SECRET }

foreach ($secret in $allSecrets) {
    gcloud secrets add-iam-policy-binding $secret `
        --project=$PROJECT_ID `
        --member="serviceAccount:$runSA" `
        --role="roles/secretmanager.secretAccessor" | Out-Null
    OK "Secret '$secret' accessible by Cloud Run"
}

# ── Redeploy ────────────────────────────────────────────────────
Step "Redeploying Cloud Run service with new configuration"
Write-Host ""
& "$PSScriptRoot\deploy.ps1" `
    -WithCloudSQL $true `
    -WithGoogle ($ggId -ne "") `
    -WithGitHub  ($ghId -ne "")

Write-Host ""
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host "  Setup complete! Nova now has:" -ForegroundColor Green
Write-Host "    ✓ Persistent PostgreSQL database (Cloud SQL)" -ForegroundColor Green
Write-Host "    ✓ Secure session key (SECRET_KEY)" -ForegroundColor Green
if ($ggId)  { Write-Host "    ✓ Google OAuth enabled"  -ForegroundColor Green }
if ($ghId)  { Write-Host "    ✓ GitHub OAuth enabled"  -ForegroundColor Green }
Write-Host "    ✓ Email/password auth always available" -ForegroundColor Green
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Green
