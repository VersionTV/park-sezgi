resource "aws_dynamodb_table" "ratings" {
  name         = "${var.project_name}-ratings"
  billing_mode = "PAY_PER_REQUEST" # Free tier friendly

  hash_key  = "wayId"
  range_key = "userId"

  attribute {
    name = "wayId"
    type = "S"
  }

  attribute {
    name = "userId"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = false
  }

  tags = {
    Name = "${var.project_name}-ratings"
  }
}
