output "artifact_registry_url" {
  description = "Docker image base URL for CI/CD"
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/nova-repo/nova-app"
}

output "cloud_sql_connection_name" {
  description = "Cloud SQL connection name"
  value       = google_sql_database_instance.nova.connection_name
}

output "github_secrets" {
  description = "Add these as GitHub Actions secrets (repo Settings > Secrets > Actions)"
  value = {
    WIF_PROVIDER        = google_iam_workload_identity_pool_provider.github.name
    WIF_SERVICE_ACCOUNT = google_service_account.github_actions.email
    GCP_PROJECT_ID      = var.project_id
  }
}

output "gke_cluster_name" {
  description = "GKE Autopilot cluster name"
  value       = google_container_cluster.nova.name
}

output "kubernetes_namespace" {
  description = "Namespace where app resources are deployed"
  value       = var.namespace
}

output "load_balancer_ip" {
  description = "Global static IP used by GKE Ingress"
  value       = google_compute_global_address.nova_ip.address
}

output "app_urls" {
  description = "Primary URLs for the application"
  value = {
    https_apex = "https://${var.domain_name}"
    https_www  = "https://www.${var.domain_name}"
    http_apex  = "http://${var.domain_name}"
  }
}
