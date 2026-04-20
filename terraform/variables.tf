variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region for all resources"
  type        = string
  default     = "us-central1"
}

variable "service_name" {
  description = "Cloud Run service name"
  type        = string
  default     = "nova-chatbot"
}

variable "github_owner" {
  description = "GitHub username or organisation"
  type        = string
  default     = "harshakuchu61"
}

variable "github_repo" {
  description = "GitHub repository name"
  type        = string
  default     = "nova_chatbot"
}

# ── Cloud SQL ─────────────────────────────────────────────────────
variable "db_tier" {
  description = "Cloud SQL machine tier. db-f1-micro ~$7/mo, db-g1-small ~$25/mo."
  type        = string
  default     = "db-f1-micro"
}

variable "sql_database" {
  description = "PostgreSQL database name"
  type        = string
  default     = "nova"
}

variable "sql_user" {
  description = "PostgreSQL username"
  type        = string
  default     = "nova_user"
}

# ── Optional secrets (leave empty to skip) ───────────────────────
variable "openai_api_key" {
  description = "OpenAI API key — stored in Secret Manager if provided"
  type        = string
  sensitive   = true
  default     = ""
}

variable "google_client_id" {
  description = "Google OAuth client ID"
  type        = string
  sensitive   = true
  default     = ""
}

variable "google_client_secret" {
  description = "Google OAuth client secret"
  type        = string
  sensitive   = true
  default     = ""
}

variable "github_client_id" {
  description = "GitHub OAuth client ID"
  type        = string
  sensitive   = true
  default     = ""
}

variable "github_client_secret" {
  description = "GitHub OAuth client secret"
  type        = string
  sensitive   = true
  default     = ""
}
