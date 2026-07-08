output "instance_id" {
  description = "The ID of the EC2 instance running the self-hosted runner"
  value       = aws_instance.runner.id
}

output "instance_public_ip" {
  description = "The public IP address of the EC2 instance"
  value       = aws_instance.runner.public_ip
}

output "runner_security_group_id" {
  description = "SG attached to the runner EC2 instance"
  value       = aws_security_group.runners.id
}

output "runner_iam_role_arn" {
  description = "IAM role assumed by the runner EC2 instance"
  value       = aws_iam_role.runner_role.arn
}

output "agent_image_uri" {
  description = "ECR image URI pre-pulled onto the runner for container jobs"
  value       = local.agent_image_uri
}
