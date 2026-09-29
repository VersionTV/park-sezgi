variable "aws_region" {
  description = "AWS region (eu-west-1 is closest to Istanbul with good free tier)"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Deployment environment"
  type        = string
  default     = "prod"
}

variable "project_name" {
  description = "Project name"
  type        = string
  default     = "parksezgi"
}

variable "google_client_id" {
  description = "Google OAuth client ID"
  type        = string
  sensitive   = true
}

variable "google_client_secret" {
  description = "Google OAuth client secret"
  type        = string
  sensitive   = true
}

variable "domain_name" {
  description = "Optional custom domain name"
  type        = string
  default     = ""
}
