resource "google_container_cluster" "nova" {
  name               = var.cluster_name
  location           = var.region
  project            = var.project_id
  enable_autopilot   = true
  deletion_protection = false

  ip_allocation_policy {}

  depends_on = [google_project_service.apis]
}

resource "google_compute_global_address" "nova_ip" {
  project    = var.project_id
  name       = "nova-ip"
  ip_version = "IPV4"
}

resource "google_service_account" "gke_runtime" {
  project      = var.project_id
  account_id   = "nova-sa"
  display_name = "Nova GKE Runtime"
}

resource "google_project_iam_member" "gke_runtime_sql" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.gke_runtime.email}"
}

resource "google_project_iam_member" "gke_runtime_secrets" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.gke_runtime.email}"
}

resource "google_project_iam_member" "gke_runtime_registry_reader" {
  project = var.project_id
  role    = "roles/artifactregistry.reader"
  member  = "serviceAccount:${google_service_account.gke_runtime.email}"
}

resource "google_project_iam_member" "gke_runtime_vertex_user" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.gke_runtime.email}"
}
