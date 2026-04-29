locals {
  # Cloud SQL connection string using unix-socket style host.
  # FastAPI runtime uses Cloud SQL Python Connector for /cloudsql/... hosts.
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

# ── VERTEX_LOCATION ────────────────────────────────────────────────
resource "google_secret_manager_secret" "vertex_location" {
  project   = var.project_id
  secret_id = "VERTEX_LOCATION"
  replication { auto {} }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "vertex_location" {
  secret      = google_secret_manager_secret.vertex_location.id
  secret_data = var.vertex_location
}

# ── VERTEX_DEFAULT_MODEL ──────────────────────────────────────────
resource "google_secret_manager_secret" "vertex_default_model" {
  project   = var.project_id
  secret_id = "VERTEX_DEFAULT_MODEL"
  replication { auto {} }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "vertex_default_model" {
  secret      = google_secret_manager_secret.vertex_default_model.id
  secret_data = var.vertex_default_model
}

# ── GOOGLE OAuth ──────────────────────────────────────────────────
resource "google_secret_manager_secret" "google_client_id" {
  project   = var.project_id
  secret_id = "GOOGLE_CLIENT_ID"
  replication { auto {} }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "google_client_id" {
  secret      = google_secret_manager_secret.google_client_id.id
  secret_data = var.google_client_id
}

resource "google_secret_manager_secret" "google_client_secret" {
  project   = var.project_id
  secret_id = "GOOGLE_CLIENT_SECRET"
  replication { auto {} }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "google_client_secret" {
  secret      = google_secret_manager_secret.google_client_secret.id
  secret_data = var.google_client_secret
}

# ── GITHUB OAuth ──────────────────────────────────────────────────
resource "google_secret_manager_secret" "github_client_id" {
  project   = var.project_id
  secret_id = "GITHUB_CLIENT_ID"
  replication { auto {} }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "github_client_id" {
  secret      = google_secret_manager_secret.github_client_id.id
  secret_data = var.github_client_id
}

resource "google_secret_manager_secret" "github_client_secret" {
  project   = var.project_id
  secret_id = "GITHUB_CLIENT_SECRET"
  replication { auto {} }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "github_client_secret" {
  secret      = google_secret_manager_secret.github_client_secret.id
  secret_data = var.github_client_secret
}
