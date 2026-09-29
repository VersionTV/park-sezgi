# Lambda archive
data "archive_file" "ratings_lambda" {
  type        = "zip"
  source_dir  = "${path.module}/lambda/ratings"
  output_path = "${path.module}/lambda/ratings.zip"
}

# IAM Role for Lambda
resource "aws_iam_role" "lambda_role" {
  name = "${var.project_name}-ratings-lambda-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })
}

# Managed policy for basic execution (CloudWatch logs)
resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Inline policy for DynamoDB and S3 access
resource "aws_iam_role_policy" "lambda_app_policy" {
  name = "${var.project_name}-lambda-app-policy"
  role = aws_iam_role.lambda_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query"
        ]
        Resource = [
          aws_dynamodb_table.ratings.arn,
          "${aws_dynamodb_table.ratings.arn}/index/*"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject"
        ]
        Resource = "${aws_s3_bucket.ratings_aggregate.arn}/*"
      }
    ]
  })
}

# Lambda function
resource "aws_lambda_function" "ratings_api" {
  filename         = data.archive_file.ratings_lambda.output_path
  function_name    = "${var.project_name}-ratings-api"
  role             = aws_iam_role.lambda_role.arn
  handler          = "index.handler"
  source_code_hash = data.archive_file.ratings_lambda.output_base64sha256
  runtime          = "nodejs20.x"
  memory_size      = 128
  timeout          = 10

  environment {
    variables = {
      RATINGS_TABLE    = aws_dynamodb_table.ratings.name
      AGGREGATE_BUCKET = aws_s3_bucket.ratings_aggregate.id
      AGGREGATE_KEY    = "ratings_aggregate.json"
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.lambda_basic,
    aws_iam_role_policy.lambda_app_policy
  ]
}
