locals {
  # Cloud SQL connection string for Cloud Run via Unix socket
  db_url = "postgresql+psycopg2://${var.sql_user}:${random_password.db_password.result}@/${var.sql_database}?host=/cloudsql/${var.project_id}:${var.region}:${google_sql_database_instance.nova.name}"
}

# ── SECRET_KEY ────────────────────────────────────────────────────
resource "google_secret_manager_secret" "secret_key" {
  project   = var.project_id
  secret_id = "SECRET_KEY"
  replication { auto {} }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "secret_key" {
  secret      = google_secret_manager_secret.secret_key.id
  secret_data = random_password.secret_key.result
}

# ── DATABASE_URL ──────────────────────────────────────────────────
resource "google_secret_manager_secret" "db_url" {
  project   = var.project_id
  secret_id = "DATABASE_URL"
  replication { auto {} }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "db_url" {
  secret      = google_secret_manager_secret.db_url.id
  secret_data = local.db_url
  depends_on  = [google_sql_database_instance.nova]
}

# ── OPENAI_API_KEY (optional) ─────────────────────────────────────
resource "google_secret_manager_secret" "openai_key" {
  count     = var.openai_api_key != "" ? 1 : 0
  project   = var.project_id
  secret_id = "OPENAI_API_KEY"
  replication { auto {} }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "openai_key" {
  count       = var.openai_api_key != "" ? 1 : 0
  secret      = google_secret_manager_secret.openai_key[0].id
  secret_data = var.openai_api_key
}

# ── GOOGLE OAuth (optional) ───────────────────────────────────────
resource "google_secret_manager_secret" "google_client_id" {
  count     = var.google_client_id != "" ? 1 : 0
  project   = var.project_id
  secret_id = "GOOGLE_CLIENT_ID"
  replication { auto {} }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "google_client_id" {
  count       = var.google_client_id != "" ? 1 : 0
  secret      = google_secret_manager_secret.google_client_id[0].id
  secret_data = var.google_client_id
}

resource "google_secret_manager_secret" "google_client_secret" {
  count     = var.google_client_secret != "" ? 1 : 0
  project   = var.project_id
  secret_id = "GOOGLE_CLIENT_SECRET"
  replication { auto {} }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "google_client_secret" {
  count       = var.google_client_secret != "" ? 1 : 0
  secret      = google_secret_manager_secret.google_client_secret[0].id
  secret_data = var.google_client_secret
}

# ── GITHUB OAuth (optional) ───────────────────────────────────────
resource "google_secret_manager_secret" "github_client_id" {
  count     = var.github_client_id != "" ? 1 : 0
  project   = var.project_id
  secret_id = "GITHUB_CLIENT_ID"
  replication { auto {} }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "github_client_id" {
  count       = var.github_client_id != "" ? 1 : 0
  secret      = google_secret_manager_secret.github_client_id[0].id
  secret_data = var.github_client_id
}

resource "google_secret_manager_secret" "github_client_secret" {
  count     = var.github_client_secret != "" ? 1 : 0
  project   = var.project_id
  secret_id = "GITHUB_CLIENT_SECRET"
  replication { auto {} }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "github_client_secret" {
  count       = var.github_client_secret != "" ? 1 : 0
  secret      = google_secret_manager_secret.github_client_secret[0].id
  secret_data = var.github_client_secret
}
