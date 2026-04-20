locals {
  # Placeholder image used on first apply.
  # CI/CD (GitHub Actions) will update this to the real image.
  # lifecycle.ignore_changes ensures terraform apply never reverts it.
  placeholder_image = "us-docker.pkg.dev/cloudrun/container/hello"
}

resource "google_cloud_run_v2_service" "nova" {
  project  = var.project_id
  name     = var.service_name
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.cloud_run.email

    scaling {
      min_instance_count = 0  # Scale to zero = no cost when idle
      max_instance_count = 3
    }

    # Cloud SQL socket mount (Auth Proxy built into Cloud Run)
    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.nova.connection_name]
      }
    }

    containers {
      image = local.placeholder_image

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }

      # SECRET_KEY injected from Secret Manager
      env {
        name = "SECRET_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret_key.secret_id
            version = "latest"
          }
        }
      }

      # DATABASE_URL injected from Secret Manager
      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.db_url.secret_id
            version = "latest"
          }
        }
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        # CPU only allocated during requests (cost saving)
        cpu_idle = false
      }

      startup_probe {
        http_get { path = "/api/config" }
        initial_delay_seconds = 5
        timeout_seconds       = 3
        period_seconds        = 10
        failure_threshold     = 3
      }
    }
  }

  # CI/CD manages the container image — terraform apply will not revert it
  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
    ]
  }

  depends_on = [
    google_project_service.apis,
    google_service_account.cloud_run,
    google_sql_database_instance.nova,
    google_secret_manager_secret_version.secret_key,
    google_secret_manager_secret_version.db_url,
    google_project_iam_member.cloud_run_sql,
    google_project_iam_member.cloud_run_secrets,
  ]
}

# Allow public (unauthenticated) access to the app
resource "google_cloud_run_v2_service_iam_member" "public_access" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.nova.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
