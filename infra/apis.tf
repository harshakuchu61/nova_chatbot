locals {
  required_apis = toset([
    "container.googleapis.com",
    "aiplatform.googleapis.com",
    "sqladmin.googleapis.com",
    "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com",
    "compute.googleapis.com",
    "dns.googleapis.com",
    "domains.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "cloudresourcemanager.googleapis.com",
  ])
}

resource "google_project_service" "apis" {
  for_each = local.required_apis
  project  = var.project_id
  service  = each.value

  # Keep APIs enabled even after terraform destroy
  # (re-enabling APIs takes time and has no cost)
  disable_on_destroy = false
}
