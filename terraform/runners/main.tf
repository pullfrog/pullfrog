terraform {
  required_version = ">= 1.5"

  # Remote state (create the bucket before first apply)
  backend "s3" {
    bucket  = "weltel-terraform-state-us-west-2-521350562101"
    key     = "runners/terraform.tfstate"
    region  = "us-west-2"
    encrypt = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region  = var.aws_region
  profile = "github"
}

locals {
  vpc_id    = var.create_vpc ? aws_vpc.runners[0].id : var.aws_vpc_id
  subnet_id = var.create_vpc ? aws_subnet.runners[0].id : var.aws_subnet_id
}

# Find latest Ubuntu 24.04 LTS AMI
data "aws_ami" "ubuntu" {
  most_recent = true
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
  owners = ["099720109477"] # Canonical owner ID
}

# IAM Role for SSM Access (allows secure shell without open ports or keys)
resource "aws_iam_role" "runner_role" {
  name = "weltel-pullfrog-runner-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Project = "weltel-pullfrog"
  }
}

# Attach SSM Core policy to Role
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.runner_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# Create Instance Profile
resource "aws_iam_instance_profile" "runner_profile" {
  name = "weltel-pullfrog-runner-profile"
  role = aws_iam_role.runner_role.name
}

# EC2 Instance
resource "aws_instance" "runner" {
  ami                  = data.aws_ami.ubuntu.id
  instance_type        = var.instance_type
  subnet_id            = local.subnet_id
  vpc_security_group_ids = [aws_security_group.runners.id]
  iam_instance_profile = aws_iam_instance_profile.runner_profile.id
  key_name             = var.ssh_key_name != "" ? var.ssh_key_name : null

  root_block_device {
    volume_size           = var.runner_volume_size
    volume_type           = "gp3"
    delete_on_termination = true
  }

  user_data = <<-EOF
              #!/bin/bash
              set -e

              # Update and install basic system packages
              apt-get update -y
              apt-get upgrade -y
              apt-get install -y curl jq git ca-certificates gnupg lsb-release build-essential

              # Install Docker
              mkdir -p /etc/apt/keyrings
              curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
              echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list
              apt-get update -y
              apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

              # Add ubuntu user to docker group
              usermod -aG docker ubuntu

              # Pre-pull Pullfrog agent image from ECR (uses instance IAM role)
              if [ "${var.prepull_agent_image}" = "true" ]; then
                apt-get install -y awscli
                aws ecr get-login-password --region ${var.aws_region} \
                  | docker login --username AWS --password-stdin ${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com
                docker pull ${local.agent_image_uri} || echo "WARN: agent image not yet in ECR — run publish-agent-image workflow first"
              fi

              # Install Node.js 24 and @nubjs/nub
              curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
              apt-get install -y nodejs
              corepack enable
              npm install -g @nubjs/nub

              # Set up actions runner directory
              RUNNER_DIR="/home/ubuntu/actions-runner"
              mkdir -p "$RUNNER_DIR"
              cd "$RUNNER_DIR"

              # Write Node script to dynamically retrieve the registration token using the GitHub App credentials
              cat << 'JS' > /home/ubuntu/get-runner-token.js
              const crypto = require('crypto');

              const appId = "${var.github_app_id}";
              const installationId = "${var.github_app_installation_id}";
              const privateKeyBase64 = "${var.github_app_key_base64}";
              const org = "${var.github_org}";
              const repo = "${var.github_repo}";

              if (!appId || !installationId || !privateKeyBase64 || !org || !repo) {
                console.error("Missing required variables.");
                process.exit(1);
              }

              const privateKey = Buffer.from(privateKeyBase64, 'base64').toString('utf8');

              function signJwt(appId, privateKeyPem) {
                const header = JSON.stringify({ alg: 'RS256', typ: 'JWT' });
                const now = Math.floor(Date.now() / 1000);
                const payload = JSON.stringify({
                  iat: now - 60,
                  exp: now + 600,
                  iss: appId
                });

                const base64Url = (str) => Buffer.from(str).toString('base64url');
                const unsignedToken = `$${base64Url(header)}.$${base64Url(payload)}`;
                const signer = crypto.createSign('RSA-SHA256');
                signer.write(unsignedToken);
                signer.end();
                const signature = signer.sign(privateKeyPem, 'base64url');
                
                return `$${unsignedToken}.$${signature}`;
              }

              async function run() {
                try {
                  const jwt = signJwt(appId, privateKey);
                  
                  // 1. Get installation access token
                  const tokenRes = await fetch(`https://api.github.com/app/installations/$${installationId}/access_tokens`, {
                    method: 'POST',
                    headers: {
                      'Authorization': `Bearer $${jwt}`,
                      'Accept': 'application/vnd.github+json',
                      'User-Agent': 'pullfrog-setup'
                    }
                  });
                  
                  if (!tokenRes.ok) {
                    const errText = await tokenRes.text();
                    throw new Error(`Failed to get access token: $${tokenRes.status} $${errText}`);
                  }
                  
                  const { token } = await tokenRes.json();
                  
                  // 2. Get runner registration token
                  const runnerRes = await fetch(`https://api.github.com/repos/$${org}/$${repo}/actions/runners/registration-token`, {
                    method: 'POST',
                    headers: {
                      'Authorization': `Bearer $${token}`,
                      'Accept': 'application/vnd.github+json',
                      'User-Agent': 'pullfrog-setup'
                    }
                  });
                  
                  if (!runnerRes.ok) {
                    const errText = await runnerRes.text();
                    throw new Error(`Failed to get runner token: $${runnerRes.status} $${errText}`);
                  }
                  
                  const { token: runnerToken } = await runnerRes.json();
                  console.log(runnerToken);
                } catch (err) {
                  console.error(err);
                  process.exit(1);
                }
              }

              run();
              JS

              chown ubuntu:ubuntu /home/ubuntu/get-runner-token.js

              # Run the script to get the registration token
              RUNNER_TOKEN=$(node /home/ubuntu/get-runner-token.js)

              # Fetch latest runner version info
              RUNNER_VERSION=$(curl -s https://api.github.com/repos/actions/runner/releases/latest | jq -r .tag_name | sed 's/^v//')
              if [ -z "$RUNNER_VERSION" ] || [ "$RUNNER_VERSION" == "null" ]; then
                RUNNER_VERSION="2.317.0"
              fi

              # Download and extract the runner
              curl -o actions-runner-linux-x64-$RUNNER_VERSION.tar.gz -L "https://github.com/actions/runner/releases/download/v$RUNNER_VERSION/actions-runner-linux-x64-$RUNNER_VERSION.tar.gz"
              tar xzf ./actions-runner-linux-x64-$RUNNER_VERSION.tar.gz
              chown -R ubuntu:ubuntu "$RUNNER_DIR"

              # Configure the runner as the ubuntu user
              sudo -u ubuntu ./config.sh --url "https://github.com/${var.github_org}/${var.github_repo}" --token "$RUNNER_TOKEN" --name "weltel-pullfrog-runner" --unattended --replace

              # Install and start the runner service
              ./svc.sh install ubuntu
              ./svc.sh start
              EOF

  tags = {
    Name    = "weltel-pullfrog-runner"
    Project = "weltel-pullfrog"
  }
}
