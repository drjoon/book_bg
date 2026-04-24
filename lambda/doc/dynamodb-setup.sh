#!/bin/bash

# DynamoDB 테이블 생성 (ap-northeast-2)
aws dynamodb create-table \
  --table-name book-debeach-slot-claims \
  --attribute-definitions AttributeName=PK,AttributeType=S \
  --key-schema AttributeName=PK,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region ap-northeast-2

# TTL 활성화 (10초 후 자동 삭제)
aws dynamodb update-time-to-live \
  --table-name book-debeach-slot-claims \
  --time-to-live-specification Enabled=true,AttributeName=TTL \
  --region ap-northeast-2

echo "✅ DynamoDB table 'book-debeach-slot-claims' created in ap-northeast-2"
echo "✅ TTL enabled on 'TTL' attribute"

# 예약 결과 저장 테이블 (EBS 폴링용)
aws dynamodb create-table \
  --table-name book-debeach-results \
  --attribute-definitions AttributeName=pk,AttributeType=S \
  --key-schema AttributeName=pk,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region ap-northeast-2

aws dynamodb wait table-exists \
  --table-name book-debeach-results \
  --region ap-northeast-2

aws dynamodb update-time-to-live \
  --table-name book-debeach-results \
  --time-to-live-specification Enabled=true,AttributeName=ttl \
  --region ap-northeast-2

echo "✅ DynamoDB table 'book-debeach-results' created in ap-northeast-2"
echo "✅ TTL enabled on 'ttl' attribute"
