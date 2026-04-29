# =============================================================
#  Nova - One-Time GCP Infrastructure Setup (legacy Cloud Run helper)
#
#  What it does:
#    1. Enables required APIs
#    2. Generates SECRET_KEY -> stores in Secret Manager
#    3. Prompts for optional OAuth credentials -> Secret Manager
#    4. Creates Cloud SQL PostgreSQL instance + DB + user
#    5. Stores DATABASE_URL in Secret Manager
#    6. Grants IAM roles to the Cloud Run service account
#    7. Redeploys with all new secrets
#
#  Run:
#    powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1
# =============================================================

$ErrorActionPreference = "Continue"

. "$PSScriptRoot\config.ps1"

function Step($msg) { Write-Host ""; Write-Host "[STEP] $msg" -ForegroundColor Cyan }
function OK($msg)   { Write-Host "  OK: $msg" -ForegroundColor Green }
function Info($msg) { Write-Host "  --  $msg" -ForegroundColor Gray }
function Warn($msg) { Write-Host "  !!  $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host ""; Write-Host "[ERROR] $msg" -ForegroundColor Red; exit 1 }

function Ensure-Secret($Name, $Value) {
    gcloud.cmd secrets describe $Name --project=$PROJECT_ID 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        gcloud.cmd secrets create $Name --project=$PROJECT_ID --replication-policy="automatic" | Out-Null
        Info "Created secret $Name"
    }
    $Value | gcloud.cmd secrets versions add $Name --project=$PROJECT_ID --data-file=- | Out-Null
    OK "Stored secret $Name"
}

if ($PROJECT_ID -eq "YOUR_PROJECT_ID") {
    Fail "Edit scripts\config.ps1 and set PROJECT_ID first."
}

Step "Verifying project: $PROJECT_ID"
gcloud.cmd config set project $PROJECT_ID | Out-Null
OK "Project set to $PROJECT_ID"

# ── Enable APIs ───────────────────────────────────────────────────
Step "Enabling required APIs"
$apis = @(
    "sqladmin.googleapis.com",
    "secretmanager.googleapis.com",
    "run.googleapis.com",
    "cloudbuild.googleapis.com"
)
foreach ($api in $apis) {
    gcloud.cmd services enable $api --project=$PROJECT_ID | Out-Null
    OK "Enabled $api"
}

# ── SECRET_KEY ────────────────────────────────────────────────────
Step "Generating SECRET_KEY"
$secretKey = -join ((1..64) | ForEach { '{0:x}' -f (Get-Random -Max 16) })
Ensure-Secret $SECRET_KEY_NAME $secretKey
Info "Key stored (truncated): $($secretKey.Substring(0,8))..."

# ── OAuth credentials (optional) ──────────────────────────────────
Step "OAuth credentials (press Enter to skip each)"
Write-Host "  Google Console: console.cloud.google.com -> APIs -> Credentials" -ForegroundColor Gray
Write-Host "  Redirect URI: https://<your-domain>/auth/google/callback" -ForegroundColor Gray

$ggId  = Read-Host "  Google Client ID (blank to skip)"
$ggSec = Read-Host "  Google Client Secret (blank to skip)"
if ($ggId -and $ggSec) {
    Ensure-Secret $GG_ID_SECRET  $ggId
    Ensure-Secret $GG_SEC_SECRET $ggSec
    OK "Google OAuth stored"
} else {
    Warn "Google OAuth skipped"
}

Write-Host ""
Write-Host "  GitHub: github.com/settings/developers -> New OAuth App" -ForegroundColor Gray
Write-Host "  Callback URL: https://<your-domain>/auth/github/callback" -ForegroundColor Gray

$ghId  = Read-Host "  GitHub Client ID (blank to skip)"
$ghSec = Read-Host "  GitHub Client Secret (blank to skip)"
if ($ghId -and $ghSec) {
    Ensure-Secret $GH_ID_SECRET  $ghId
    Ensure-Secret $GH_SEC_SECRET $ghSec
    OK "GitHub OAuth stored"
} else {
    Warn "GitHub OAuth skipped"
}

# ── Cloud SQL ─────────────────────────────────────────────────────
Step "Creating Cloud SQL PostgreSQL instance: $SQL_INSTANCE"
Info "This takes 5-10 minutes..."

gcloud.cmd sql instances describe $SQL_INSTANCE --project=$PROJECT_ID 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
    Warn "Instance $SQL_INSTANCE already exists - skipping creation"
} else {
    gcloud.cmd sql instances create $SQL_INSTANCE `
        --project=$PROJECT_ID `
        --database-version=POSTGRES_15 `
        --tier=db-f1-micro `
        --region=$REGION `
        --storage-type=SSD `
        --storage-size=10GB `
        --storage-auto-increase `
        --backup-start-time=03:00 `
        --availability-type=zonal
    if ($LASTEXITCODE -ne 0) { Fail "Cloud SQL instance creation failed." }
    OK "Instance created"
}

Step "Creating database and user"
gcloud.cmd sql databases create $SQL_DATABASE `
    --instance=$SQL_INSTANCE `
    --project=$PROJECT_ID 2>$null | Out-Null

$dbPassword = -join ((1..32) | ForEach { [char](Get-Random -Min 97 -Max 123) })

gcloud.cmd sql users create $SQL_USER `
    --instance=$SQL_INSTANCE `
    --project=$PROJECT_ID `
    --password=$dbPassword 2>$null | Out-Null
OK "Database and user created"

$dbUrl = "postgresql+psycopg2://${SQL_USER}:${dbPassword}@/${SQL_DATABASE}?host=/cloudsql/${SQL_CONN}"
Ensure-Secret $DB_URL_SECRET_NAME $dbUrl
OK "DATABASE_URL stored"

# ── IAM permissions ───────────────────────────────────────────────
Step "Granting Cloud Run service account access to Cloud SQL and secrets"
$projectNumber = gcloud.cmd projects describe $PROJECT_ID --format="value(projectNumber)"
$runSA = "${projectNumber}-compute@developer.gserviceaccount.com"
Info "Cloud Run SA: $runSA"

gcloud.cmd projects add-iam-policy-binding $PROJECT_ID `
    --member="serviceAccount:$runSA" `
    --role="roles/cloudsql.client" | Out-Null
OK "Granted roles/cloudsql.client"

$allSecrets = @("OPENAI_API_KEY", $SECRET_KEY_NAME, $DB_URL_SECRET_NAME)
if ($ggId)  { $allSecrets += $GG_ID_SECRET;  $allSecrets += $GG_SEC_SECRET }
if ($ghId)  { $allSecrets += $GH_ID_SECRET;  $allSecrets += $GH_SEC_SECRET }

foreach ($secret in $allSecrets) {
    gcloud.cmd secrets add-iam-policy-binding $secret `
        --project=$PROJECT_ID `
        --member="serviceAccount:$runSA" `
        --role="roles/secretmanager.secretAccessor" | Out-Null
    OK "Secret $secret accessible by Cloud Run"
}

# ── Redeploy ──────────────────────────────────────────────────────
Step "Redeploying with new configuration"
$withGoogle = if ($ggId) { 1 } else { 0 }
$withGitHub = if ($ghId) { 1 } else { 0 }
powershell -ExecutionPolicy Bypass -File "$PSScriptRoot\deploy.ps1" -WithCloudSQL 1 -WithGoogle $withGoogle -WithGitHub $withGitHub

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  Setup complete! Nova now has:"                              -ForegroundColor Green
Write-Host "  - Persistent PostgreSQL database (Cloud SQL)"              -ForegroundColor Green
Write-Host "  - Secure session key (SECRET_KEY)"                         -ForegroundColor Green
if ($ggId) { Write-Host "  - Google OAuth enabled" -ForegroundColor Green }
if ($ghId) { Write-Host "  - GitHub OAuth enabled" -ForegroundColor Green }
Write-Host "  - Email/password auth always available"                    -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
