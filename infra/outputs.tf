output "cloudfront_url" {
  description = "CloudFront distribution domain"
  value       = aws_cloudfront_distribution.main.domain_name
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID"
  value       = aws_cloudfront_distribution.main.id
}

output "api_gateway_url" {
  description = "API Gateway invoke URL"
  value       = aws_api_gateway_stage.api_stage.invoke_url
}

output "cognito_user_pool_id" {
  description = "Cognito User Pool ID"
  value       = aws_cognito_user_pool.users.id
}

output "cognito_client_id" {
  description = "Cognito App Client ID"
  value       = aws_cognito_user_pool_client.web_client.id
}

output "cognito_domain" {
  description = "Cognito hosted UI domain"
  value       = local.cognito_domain
}

output "static_bucket" {
  description = "S3 bucket name for frontend deployment"
  value       = aws_s3_bucket.static_site.bucket
}

output "ratings_bucket" {
  description = "S3 bucket name for ratings aggregate"
  value       = aws_s3_bucket.ratings_aggregate.bucket
}
