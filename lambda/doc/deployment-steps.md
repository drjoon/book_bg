# DynamoDB 슬롯 충돌 방지 시스템 배포 가이드

## 1. DynamoDB 테이블 생성

```bash
cd /Users/joonholee/Joon/1-Project/dev/book/lambda/doc
chmod +x dynamodb-setup.sh
./dynamodb-setup.sh
```

또는 직접 실행:

```bash
# 테이블 생성
aws dynamodb create-table \
  --table-name book-debeach-slot-claims \
  --attribute-definitions AttributeName=PK,AttributeType=S \
  --key-schema AttributeName=PK,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region ap-south-1

# TTL 활성화 (10초)
aws dynamodb update-time-to-live \
  --table-name book-debeach-slot-claims \
  --time-to-live-specification Enabled=true,AttributeName=TTL \
  --region ap-south-1
```

## 2. Lambda IAM 역할에 DynamoDB 권한 추가

```bash
# 정책 파일 생성 (이미 생성됨: lambda/doc/iam-policy.json)

# IAM 역할에 인라인 정책 추가
aws iam put-role-policy \
  --role-name book-debeach-lambda-role \
  --policy-name DynamoDBSlotClaimsAccess \
  --policy-document file:///Users/joonholee/Joon/1-Project/dev/book/lambda/doc/iam-policy.json
```

## 3. Lambda 패키지 빌드 및 배포

```bash
cd /Users/joonholee/Joon/1-Project/dev/book/lambda/book-debeach

# 의존성 설치
npm install

# 빌드
npm run build

# Lambda 업데이트
aws lambda update-function-code \
  --function-name book-debeach \
  --zip-file fileb://deployment_package.zip \
  --region ap-south-1
```

## 4. 테스트

```bash
# 테스트 실행
aws lambda invoke \
  --function-name book-debeach \
  --region ap-south-1 \
  --payload file://test/event-test.json \
  --cli-binary-format raw-in-base64-out \
  test/output.json

# 로그 확인
aws logs tail /aws/lambda/book-debeach \
  --region ap-south-1 \
  --since 5m \
  --follow
```

## 5. DynamoDB 데이터 확인

```bash
# 현재 예약된 슬롯 조회
aws dynamodb scan \
  --table-name book-debeach-slot-claims \
  --region ap-south-1
```

## 동작 방식

1. Lambda 시작 시 DynamoDB에서 이미 예약된 슬롯 조회
2. 예약 시도 전 DynamoDB에 슬롯 등록 (조건부 쓰기)
3. 등록 성공 시에만 실제 예약 시도
4. 10초 후 TTL로 자동 삭제 (실패한 예약 정리)

## 예상 로그

```
[김노현] 📋 Already claimed by other Lambdas: 0 slots
[김노현] 🎯 Primary target (queued loop): 1144 on course A (totalTargets=7)
[김노현] ✅ Claimed slot 1144 (A) in DynamoDB
[김노현] ➡️ Trying to book time: 1144 on course A

[박신일] 📋 Already claimed by other Lambdas: 1 slots
[박신일] 🎯 Primary target (queued loop): 1151 on course B (totalTargets=6)
[박신일] ✅ Claimed slot 1151 (B) in DynamoDB
[박신일] ➡️ Trying to book time: 1151 on course B
```

## 주의사항

- DynamoDB 읽기/쓰기로 약 10-20ms 추가 지연 발생
- TTL은 10초로 설정 (실패한 예약은 10초 후 재시도 가능)
- Lambda 간 슬롯 충돌 대폭 감소 예상
