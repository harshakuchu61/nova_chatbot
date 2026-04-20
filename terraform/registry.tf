resource "google_artifact_registry_repository" "nova" {
  project       = var.project_id
  location      = var.region
  repository_id = "nova-repo"
  format        = "DOCKER"
  description   = "Nova Chatbot Docker images"

  depends_on = [google_project_service.apis]
}
