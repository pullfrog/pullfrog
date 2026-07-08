# GitHub Actions Self-Hosted Persistent EC2 Runner

This directory contains the Terraform configurations to manage a single, persistent AWS EC2 self-hosted runner to run the Pullfrog agent.

## Infrastructure Architecture

Unlike auto-scaling serverless configurations, this deployment creates exactly one persistent EC2 instance (Ubuntu 24.04 LTS).

To maintain secure, automated deployments, the instance leverages **GitHub App Authentication** on boot:
1. The EC2 instance starts up with your configured **GitHub App credentials**.
2. It executes a local Node.js script that dynamically signs a JSON Web Token (JWT), exchanges it for a GitHub Installation Access Token, and requests a fresh runner registration token.
3. The instance then downloads, configures, and registers itself as a self-hosted runner, running as a systemd service.

This dynamic registration setup ensures that if the EC2 instance is ever restarted, scaled, or replaced, it automatically registers itself without human intervention.

---

## Provisioned Resources

When deployed, Terraform provisions:
- **Virtual Private Cloud (VPC) & Subnets:** Optional dedicated networks (or fits within your existing VPC).
- **Security Group:** Configured with outbound access to talk to GitHub, download packages, and optional inbound SSH.
- **IAM Instance Profile:** Attached to the runner to utilize AWS Systems Manager (SSM) Session Manager for secure SSH-free logins.
- **EC2 Instance:** A persistent, single instance running Ubuntu 24.04 LTS (defaulting to a `t3.medium`).

---

## Deployment Options

### Option A: Automatic via GitHub Actions (Recommended)
You can deploy and manage this infrastructure directly from your repository's Actions tab:
1. Navigate to **Actions** -> **Deploy Auto-Scaling Runners** (or Deploy Persistent Runner).
2. Run the workflow manually with `workflow_dispatch`.
3. Inputs:
   - **Action:** `plan` (dry run), `apply` (deploy updates), `destroy` (tear down).

### Option B: Local CLI Deployment
If you prefer running commands locally on your machine:
```bash
cd terraform/runners

# 1. Prepare variables
cp terraform.tfvars_sample terraform.tfvars
# Open terraform.tfvars and fill in values (App ID, Private Key, installation ID, Subnets, etc.)

# 2. Deploy the infrastructure
terraform init
terraform apply -auto-approve
```

---

## Required Secrets & Variables

To configure and deploy the runner, you must define the following variables:

| Variable | Description |
|----------|-------------|
| `github_app_id` | GitHub App ID registered at the Org or Repo level. |
| `github_app_key_base64` | Base64-encoded private PEM key of the registered GitHub App. |
| `github_app_installation_id` | The Installation ID of the GitHub App on your repository/org. |
| `github_org` | GitHub Organization or username. |
| `github_repo` | Target repository name (e.g. `weltel-pullfrog`). |
| `aws_vpc_id` | VPC ID where runner subnets reside. |
| `aws_subnet_id` | Subnet ID for EC2 instance launch. |
| `instance_type` | Instance type (defaults to `t3.medium`). |
