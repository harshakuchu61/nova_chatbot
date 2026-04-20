# =============================================================
#  Nova Chatbot - Terraform Infrastructure
#  Project: nova-chatbot-493921 | Region: us-central1
#
#  USAGE:
#    terraform init
#    terraform plan
#    terraform apply        # spin up everything
#    terraform destroy      # tear down everything (stops billing)
#
#  IMPORT existing manually-created resources (run once):
#    terraform import google_iam_workload_identity_pool.github projects/nova-chatbot-493921/locations/global/workloadIdentityPools/github-pool
#    terraform import google_iam_workload_identity_pool_provider.github projects/nova-chatbot-493921/locations/global/workloadIdentityPools/github-pool/providers/github-provider
#    terraform import google_service_account.github_actions projects/nova-chatbot-493921/serviceAccounts/github-actions-sa@nova-chatbot-493921.iam.gserviceaccount.com
# =============================================================

terraform {
  required_version = ">= 1.5"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # GCS backend keeps state safe across destroy/apply cycles.
  # Create the bucket once (it survives terraform destroy):
  #   gcloud.cmd storage buckets create gs://nova-chatbot-tfstate --project=nova-chatbot-493921 --location=us-central1
  # Then uncomment:
  # backend "gcs" {
  #   bucket = "nova-chatbot-tfstate"
  #   prefix = "terraform/state"
  # }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# Generates a 64-char random Flask SECRET_KEY (stored in Secret Manager)
resource "random_password" "secret_key" {
  length  = 64
  special = false
}

# Generates a secure Cloud SQL password
resource "random_password" "db_password" {
  length  = 32
  special = false
}
