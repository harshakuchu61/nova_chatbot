# =============================================================
#  Nova — GCP Shared Configuration
#  Edit the values in this file once; all scripts source it.
# =============================================================

# ── REQUIRED — set this to your GCP Project ID ──────────
$PROJECT_ID   = "nova-chatbot-493921"

# ── GCP topology ───────
$REGION       = "us-central1"
$SERVICE_NAME = "nova-chatbot"
$REPO_NAME    = "nova-repo"
$IMAGE_NAME   = "nova-app"

# ── Cloud SQL (PostgreSQL) ─────────────────────────────────────
$SQL_INSTANCE = "nova-db"          # Cloud SQL instance name
$SQL_DATABASE = "nova"             # PostgreSQL database name
$SQL_USER     = "nova_user"        # PostgreSQL user

# ── Secret Manager secret names ───────────────────────────────
$SECRET_KEY_NAME    = "SECRET_KEY"
$DB_URL_SECRET_NAME = "DATABASE_URL"
$GH_ID_SECRET       = "GITHUB_CLIENT_ID"
$GH_SEC_SECRET      = "GITHUB_CLIENT_SECRET"
$GG_ID_SECRET       = "GOOGLE_CLIENT_ID"
$GG_SEC_SECRET      = "GOOGLE_CLIENT_SECRET"

# ── Derived values (don't edit these) ─────────────────────────
$IMAGE_PATH   = "${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO_NAME}/${IMAGE_NAME}"
$SQL_CONN     = "${PROJECT_ID}:${REGION}:${SQL_INSTANCE}"
