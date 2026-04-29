resource "google_sql_database_instance" "nova" {
  project          = var.project_id
  name             = "nova-db"
  database_version = "POSTGRES_15"
  region           = var.region

  deletion_protection = var.db_deletion_protection

  settings {
    tier              = var.db_tier
    availability_type = "ZONAL"
    disk_autoresize   = true
    disk_size         = 10
    disk_type         = "PD_SSD"

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = "03:00"
    }

    ip_configuration {
      # Public IP required for Cloud SQL Auth Proxy without VPC
      ipv4_enabled = true
    }

    database_flags {
      name  = "max_connections"
      value = "100"
    }
  }

  # Uncomment in production to prevent accidental deletion:
  # deletion_protection = true

  depends_on = [google_project_service.apis]
}

resource "google_sql_database" "nova" {
  project  = var.project_id
  instance = google_sql_database_instance.nova.name
  name     = var.sql_database
}

resource "google_sql_user" "nova" {
  project  = var.project_id
  instance = google_sql_database_instance.nova.name
  name     = var.sql_user
  password = random_password.db_password.result
}
