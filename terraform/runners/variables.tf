variable "aws_region" {
  description = "AWS region for the runner"
  type        = string
  default     = "us-west-2"
}

variable "create_vpc" {
  description = "Set to true to create a new VPC for the runner; false to reuse an existing one"
  type        = bool
  default     = false
}

variable "aws_vpc_id" {
  description = "Existing VPC ID (only used when create_vpc = false)"
  type        = string
  default     = ""
}

variable "aws_subnet_id" {
  description = "Existing subnet ID (only used when create_vpc = false)"
  type        = string
  default     = ""
}

#  GitHub App credentials 
variable "github_app_id" {
  description = "GitHub App ID for the runner registration"
  type        = string
}

variable "github_app_key_base64" {
  description = "Base64-encoded contents of the GitHub App private key (.pem)"
  type        = string
  sensitive   = true
}

variable "github_app_installation_id" {
  description = "GitHub App Installation ID to retrieve access tokens"
  type        = string
}

#  Runner scope 
variable "github_org" {
  description = "GitHub organisation or user name (e.g. 'Weltel-repo')"
  type        = string
}

variable "github_repo" {
  description = "Repository name (e.g. 'weltel-pullfrog')"
  type        = string
}

variable "instance_type" {
  description = "The EC2 instance type for the persistent runner"
  type        = string
  default     = "t3.medium" # t3.medium has 2 vCPUs and 4GB RAM, ideal for agent runs
}

variable "runner_volume_size" {
  description = "EBS root volume size (GB) for the runner"
  type        = number
  default     = 30
}

variable "ssh_key_name" {
  type        = string
  description = "The name of an existing AWS key pair to allow SSH access (optional)"
  default     = ""
}

variable "allowed_ssh_cidr" {
  type        = string
  description = "The CIDR block permitted to SSH into the instance"
  default     = "0.0.0.0/0"
}

variable "agent_ecr_repository" {
  description = "ECR repository name for the Pullfrog agent container image"
  type        = string
  default     = "pullfrog-agent"
}

variable "agent_image_tag" {
  description = "ECR image tag to pre-pull onto the runner at boot"
  type        = string
  default     = "latest"
}

variable "prepull_agent_image" {
  description = "Pull the agent image from ECR during instance boot"
  type        = bool
  default     = true
}
