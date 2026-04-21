output "cloud_run_url" {
  description = "Live application URL"
  value       = google_cloud_run_v2_service.nova.uri
}

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
