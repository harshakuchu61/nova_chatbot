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
  description = "Kubernetes application name"
  type        = string
  default     = "nova-app"
}

variable "cluster_name" {
  description = "GKE Autopilot cluster name"
  type        = string
  default     = "nova-cluster"
}

variable "namespace" {
  description = "Kubernetes namespace for app resources"
  type        = string
  default     = "nova"
}

variable "domain_name" {
  description = "Primary domain for ingress and OAuth callbacks (e.g., novagptapp.com)"
  type        = string
  default     = "novagptapp.com"
}

variable "create_dns_records" {
  description = "Whether Terraform should create apex/www A records"
  type        = bool
  default     = true
}

variable "dns_zone_name" {
  description = "Cloud DNS managed zone name for domain_name"
  type        = string
  default     = "novagptapp-com"
}

variable "enable_https_redirect" {
  description = "When true, disables plain HTTP on Ingress (set true after cert is active)"
  type        = bool
  default     = false
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

variable "db_deletion_protection" {
  description = "Protect Cloud SQL from accidental deletion"
  type        = bool
  default     = false
}

variable "min_replicas" {
  description = "Minimum app replicas in Kubernetes"
  type        = number
  default     = 3
}

variable "max_replicas" {
  description = "Maximum app replicas in Kubernetes"
  type        = number
  default     = 10
}

# ── Vertex AI runtime config ──────────────────────────────────────
variable "vertex_location" {
  description = "Vertex AI region for model inference"
  type        = string
  default     = "us-central1"
}

variable "vertex_default_model" {
  description = "Default Vertex Gemini model ID"
  type        = string
  default     = "gemini-2.0-flash"
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
