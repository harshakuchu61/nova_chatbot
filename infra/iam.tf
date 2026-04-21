# ── GitHub Actions Service Account ────────────────────────────────
resource "google_service_account" "github_actions" {
  project      = var.project_id
  account_id   = "github-actions-sa"
  display_name = "GitHub Actions Nova CI/CD"
}

locals {
  github_sa_roles = toset([
    "roles/run.admin",                 # deploy Cloud Run
    "roles/artifactregistry.writer",   # push Docker images
    "roles/iam.serviceAccountUser",    # act-as Cloud Run SA
    "roles/storage.admin",             # Cloud Build staging bucket
  ])
}

resource "google_project_iam_member" "github_actions" {
  for_each = local.github_sa_roles
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.github_actions.email}"
}

# ── Cloud Run Runtime Service Account ─────────────────────────────
resource "google_service_account" "cloud_run" {
  project      = var.project_id
  account_id   = "nova-cloudrun-sa"
  display_name = "Nova Cloud Run Runtime"
}

resource "google_project_iam_member" "cloud_run_sql" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.cloud_run.email}"
}

resource "google_project_iam_member" "cloud_run_secrets" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.cloud_run.email}"
}

# ── Workload Identity Federation (keyless GitHub Actions auth) ─────
resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = "github-pool"
  display_name              = "GitHub Actions Pool"

  depends_on = [google_project_service.apis]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-provider"
  display_name                       = "GitHub OIDC Provider"

  attribute_mapping = {
    "google.subject"             = "assertion.sub"
    "attribute.actor"            = "assertion.actor"
    "attribute.repository"       = "assertion.repository"
    "attribute.repository_owner" = "assertion.repository_owner"
  }

  # Only tokens from your GitHub account are accepted
  attribute_condition = "assertion.repository_owner == '${var.github_owner}'"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

# Bind WIF provider to the GitHub Actions service account
resource "google_service_account_iam_member" "github_wif" {
  service_account_id = google_service_account.github_actions.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_owner}/${var.github_repo}"
}
