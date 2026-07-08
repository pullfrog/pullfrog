data "aws_caller_identity" "current" {}

data "aws_ecr_repository" "agent" {
  name = var.agent_ecr_repository
}

locals {
  agent_image_uri = "${data.aws_ecr_repository.agent.repository_url}:${var.agent_image_tag}"
}

resource "aws_iam_role_policy" "runner_ecr_pull" {
  name = "weltel-pullfrog-runner-ecr-pull"
  role = aws_iam_role.runner_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "EcrAuth"
        Effect = "Allow"
        Action = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Sid    = "EcrPull"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
        ]
        Resource = data.aws_ecr_repository.agent.arn
      },
    ]
  })
}