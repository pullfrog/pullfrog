# Networking for GitHub Actions self-hosted runners
# Creates a VPC, subnet, and security group for EC2 runners.

# VPC
resource "aws_vpc" "runners" {
  count      = var.create_vpc ? 1 : 0
  cidr_block = "10.0.0.0/16"

  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name    = "weltel-pullfrog-runner-vpc"
    Project = "weltel-pullfrog"
  }
}

resource "aws_internet_gateway" "runners" {
  count  = var.create_vpc ? 1 : 0
  vpc_id = aws_vpc.runners[0].id

  tags = {
    Name    = "weltel-pullfrog-runner-igw"
    Project = "weltel-pullfrog"
  }
}

resource "aws_route_table" "runners" {
  count  = var.create_vpc ? 1 : 0
  vpc_id = aws_vpc.runners[0].id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.runners[0].id
  }

  tags = {
    Name    = "weltel-pullfrog-runner-rt"
    Project = "weltel-pullfrog"
  }
}

# Subnet   
resource "aws_subnet" "runners" {
  count                   = var.create_vpc ? 1 : 0
  vpc_id                  = aws_vpc.runners[0].id
  cidr_block              = "10.0.1.0/24"
  availability_zone       = "${var.aws_region}a"
  map_public_ip_on_launch = true

  tags = {
    Name    = "weltel-pullfrog-runner-subnet"
    Project = "weltel-pullfrog"
  }
}

resource "aws_route_table_association" "runners" {
  count          = var.create_vpc ? 1 : 0
  subnet_id      = aws_subnet.runners[0].id
  route_table_id = aws_route_table.runners[0].id
}

# Security Group
resource "aws_security_group" "runners" {
  name        = "weltel-pullfrog-runner-sg"
  description = "Security group for GitHub Actions self-hosted runners"
  vpc_id      = var.create_vpc ? aws_vpc.runners[0].id : var.aws_vpc_id

  # Runners only need outbound access (HTTPS to GitHub + ECR)
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Allow all outbound traffic"
  }

  tags = {
    Name    = "weltel-pullfrog-runner-sg"
    Project = "weltel-pullfrog"
  }
}
