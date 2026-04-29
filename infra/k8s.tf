locals {
  app_labels = {
    app = var.service_name
  }

  image_ref = "${var.region}-docker.pkg.dev/${var.project_id}/nova-repo/nova-app:latest"
}

resource "kubernetes_namespace_v1" "nova" {
  metadata {
    name = var.namespace
    labels = {
      "app.kubernetes.io/name" = "nova"
    }
  }

  depends_on = [google_container_cluster.nova]
}

resource "kubernetes_service_account_v1" "nova" {
  metadata {
    name      = "nova-ksa"
    namespace = kubernetes_namespace_v1.nova.metadata[0].name
    annotations = {
      "iam.gke.io/gcp-service-account" = google_service_account.gke_runtime.email
    }
  }
}

resource "google_service_account_iam_member" "gke_workload_identity" {
  service_account_id = google_service_account.gke_runtime.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[${var.namespace}/${kubernetes_service_account_v1.nova.metadata[0].name}]"
}

resource "kubernetes_secret_v1" "app_secrets" {
  metadata {
    name      = "nova-app-secrets"
    namespace = kubernetes_namespace_v1.nova.metadata[0].name
  }

  data = {
    SECRET_KEY           = random_password.secret_key.result
    DATABASE_URL         = local.db_url
    GOOGLE_CLOUD_PROJECT = var.project_id
    VERTEX_LOCATION      = var.vertex_location
    VERTEX_DEFAULT_MODEL = var.vertex_default_model
    GOOGLE_CLIENT_ID     = var.google_client_id
    GOOGLE_CLIENT_SECRET = var.google_client_secret
    GITHUB_CLIENT_ID     = var.github_client_id
    GITHUB_CLIENT_SECRET = var.github_client_secret
  }

  type = "Opaque"
}

resource "kubernetes_deployment_v1" "nova" {
  metadata {
    name      = var.service_name
    namespace = kubernetes_namespace_v1.nova.metadata[0].name
    labels    = local.app_labels
  }

  spec {
    replicas = var.min_replicas

    selector {
      match_labels = local.app_labels
    }

    strategy {
      type = "RollingUpdate"
      rolling_update {
        max_surge       = "1"
        max_unavailable = "0"
      }
    }

    template {
      metadata {
        labels = local.app_labels
      }

      spec {
        service_account_name = kubernetes_service_account_v1.nova.metadata[0].name
        volume {
          name = "cloudsql"
          empty_dir {}
        }

        container {
          name              = "nova-app"
          image             = local.image_ref
          image_pull_policy = "Always"

          port {
            container_port = 8080
          }

          env {
            name  = "PORT"
            value = "8080"
          }

          env {
            name  = "DEPLOYMENT_ENV"
            value = "gke"
          }

          env_from {
            secret_ref {
              name = kubernetes_secret_v1.app_secrets.metadata[0].name
            }
          }

          resources {
            requests = {
              cpu    = "300m"
              memory = "384Mi"
            }
            limits = {
              cpu    = "2000m"
              memory = "1Gi"
            }
          }

          startup_probe {
            http_get {
              path = "/health"
              port = 8080
            }
            period_seconds    = 10
            timeout_seconds   = 5
            failure_threshold = 18
          }

          readiness_probe {
            http_get {
              path = "/health"
              port = 8080
            }
            initial_delay_seconds = 20
            period_seconds        = 10
            timeout_seconds       = 5
            failure_threshold     = 5
          }

          liveness_probe {
            http_get {
              path = "/health"
              port = 8080
            }
            initial_delay_seconds = 60
            period_seconds        = 30
            timeout_seconds       = 5
            failure_threshold     = 5
          }

          volume_mount {
            name       = "cloudsql"
            mount_path = "/cloudsql"
          }
        }

        container {
          name              = "cloud-sql-proxy"
          image             = "gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.11.4"
          image_pull_policy = "IfNotPresent"
          args              = ["--structured-logs", "--unix-socket=/cloudsql", "${var.project_id}:${var.region}:${google_sql_database_instance.nova.name}"]

          resources {
            requests = {
              cpu    = "100m"
              memory = "128Mi"
            }
            limits = {
              cpu    = "250m"
              memory = "256Mi"
            }
          }

          security_context {
            run_as_non_root = true
          }

          volume_mount {
            name       = "cloudsql"
            mount_path = "/cloudsql"
          }
        }
      }
    }
  }

  depends_on = [google_service_account_iam_member.gke_workload_identity]
}

resource "kubernetes_service_v1" "nova" {
  metadata {
    name      = "nova-service"
    namespace = kubernetes_namespace_v1.nova.metadata[0].name
    annotations = {
      "cloud.google.com/neg" = "{\"ingress\": true}"
    }
  }

  spec {
    selector = local.app_labels

    port {
      name        = "http"
      port        = 80
      target_port = 8080
    }
  }
}

resource "kubernetes_manifest" "managed_cert" {
  manifest = {
    apiVersion = "networking.gke.io/v1"
    kind       = "ManagedCertificate"
    metadata = {
      name      = "nova-cert"
      namespace = kubernetes_namespace_v1.nova.metadata[0].name
    }
    spec = {
      domains = [
        var.domain_name,
        "www.${var.domain_name}",
      ]
    }
  }
}

resource "kubernetes_ingress_v1" "nova" {
  metadata {
    name      = "nova-ingress"
    namespace = kubernetes_namespace_v1.nova.metadata[0].name
    annotations = {
      "kubernetes.io/ingress.class"                 = "gce"
      "kubernetes.io/ingress.global-static-ip-name" = google_compute_global_address.nova_ip.name
      "networking.gke.io/managed-certificates"      = "nova-cert"
      "kubernetes.io/ingress.allow-http"            = var.enable_https_redirect ? "false" : "true"
    }
  }

  spec {
    ingress_class_name = "gce"

    rule {
      host = var.domain_name
      http {
        path {
          path      = "/"
          path_type = "Prefix"
          backend {
            service {
              name = kubernetes_service_v1.nova.metadata[0].name
              port {
                number = 80
              }
            }
          }
        }
      }
    }

    rule {
      host = "www.${var.domain_name}"
      http {
        path {
          path      = "/"
          path_type = "Prefix"
          backend {
            service {
              name = kubernetes_service_v1.nova.metadata[0].name
              port {
                number = 80
              }
            }
          }
        }
      }
    }
  }

  depends_on = [kubernetes_manifest.managed_cert]
}

resource "kubernetes_horizontal_pod_autoscaler_v2" "nova" {
  metadata {
    name      = "nova-hpa"
    namespace = kubernetes_namespace_v1.nova.metadata[0].name
  }

  spec {
    min_replicas = var.min_replicas
    max_replicas = var.max_replicas

    scale_target_ref {
      api_version = "apps/v1"
      kind        = "Deployment"
      name        = kubernetes_deployment_v1.nova.metadata[0].name
    }

    metric {
      type = "Resource"
      resource {
        name = "cpu"
        target {
          type                = "Utilization"
          average_utilization = 50
        }
      }
    }

    metric {
      type = "Resource"
      resource {
        name = "memory"
        target {
          type                = "Utilization"
          average_utilization = 75
        }
      }
    }
  }
}
