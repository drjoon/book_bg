#!/bin/bash

# DynamoDB 테이블 생성 (ap-south-1)
aws dynamodb create-table \
  --table-name book-debeach-slot-claims \
  --attribute-definitions AttributeName=PK,AttributeType=S \
  --key-schema AttributeName=PK,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region ap-south-1

# TTL 활성화 (10초 후 자동 삭제)
aws dynamodb update-time-to-live \
  --table-name book-debeach-slot-claims \
  --time-to-live-specification Enabled=true,AttributeName=TTL \
  --region ap-south-1

echo "✅ DynamoDB table 'book-debeach-slot-claims' created in ap-south-1"
echo "✅ TTL enabled on 'TTL' attribute"
