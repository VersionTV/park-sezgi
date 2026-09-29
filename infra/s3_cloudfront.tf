data "aws_caller_identity" "current" {}

# S3 Bucket: Static Site
resource "aws_s3_bucket" "static_site" {
  bucket = "${var.project_name}-static-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "static_site_pab" {
  bucket = aws_s3_bucket.static_site.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "static_site_versioning" {
  bucket = aws_s3_bucket.static_site.id
  versioning_configuration {
    status = "Suspended"
  }
}

# S3 Bucket: Ratings Aggregate
resource "aws_s3_bucket" "ratings_aggregate" {
  bucket = "${var.project_name}-ratings-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "ratings_aggregate_pab" {
  bucket = aws_s3_bucket.ratings_aggregate.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_cors_configuration" "ratings_aggregate_cors" {
  bucket = aws_s3_bucket.ratings_aggregate.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET"]
    allowed_origins = ["*"]
    expose_headers  = []
    max_age_seconds = 3000
  }
}

# CloudFront OAC
resource "aws_cloudfront_origin_access_control" "main" {
  name                              = "${var.project_name}-oac"
  description                       = "OAC for ${var.project_name}"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# CloudFront Distribution
resource "aws_cloudfront_distribution" "main" {
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  price_class         = "PriceClass_100"

  # Static Origin
  origin {
    domain_name              = aws_s3_bucket.static_site.bucket_regional_domain_name
    origin_id                = "staticSiteOrigin"
    origin_access_control_id = aws_cloudfront_origin_access_control.main.id
  }

  # Aggregate Origin
  origin {
    domain_name              = aws_s3_bucket.ratings_aggregate.bucket_regional_domain_name
    origin_id                = "ratingsAggregateOrigin"
    origin_access_control_id = aws_cloudfront_origin_access_control.main.id
  }

  # Default Behavior - Static Site
  default_cache_behavior {
    allowed_methods  = ["GET", "HEAD", "OPTIONS"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "staticSiteOrigin"

    viewer_protocol_policy = "redirect-to-https"

    # CachingOptimized Managed Policy
    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  }

  # Ordered Behavior - Ratings Aggregate
  ordered_cache_behavior {
    path_pattern     = "/ratings_aggregate.json"
    allowed_methods  = ["GET", "HEAD", "OPTIONS"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "ratingsAggregateOrigin"

    viewer_protocol_policy = "redirect-to-https"

    # CachingDisabled Managed Policy
    cache_policy_id = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
  }

  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 10
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

# S3 Bucket Policy: Static Site
resource "aws_s3_bucket_policy" "static_site_policy" {
  bucket = aws_s3_bucket.static_site.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowCloudFrontServicePrincipalReadOnly"
        Effect = "Allow"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.static_site.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.main.arn
          }
        }
      }
    ]
  })
}

# S3 Bucket Policy: Ratings Aggregate
resource "aws_s3_bucket_policy" "ratings_aggregate_policy" {
  bucket = aws_s3_bucket.ratings_aggregate.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowCloudFrontServicePrincipalReadOnly"
        Effect = "Allow"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.ratings_aggregate.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.main.arn
          }
        }
      }
    ]
  })
}
