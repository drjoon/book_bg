# DynamoDB 테이블 수동 생성 가이드 (AWS 콘솔)

CLI 권한이 없으므로 AWS 콘솔에서 직접 생성합니다.

## 1. AWS 콘솔에서 DynamoDB 테이블 생성

1. **AWS 콘솔 접속**
   - https://ap-south-1.console.aws.amazon.com/dynamodbv2/home?region=ap-south-1

2. **테이블 생성**
   - "Create table" 클릭
   
3. **테이블 설정**
   ```
   Table name: book-debeach-slot-claims
   Partition key: PK (String)
   ```

4. **테이블 설정 (Table settings)**
   - "Customize settings" 선택
   - Table class: DynamoDB Standard
   - Capacity mode: **On-demand** 선택

5. **TTL 설정 (Time to Live)**
   - "Additional settings" 섹션에서
   - TTL attribute: `TTL`
   - Enable TTL 체크

6. **생성 완료**
   - "Create table" 클릭
   - 테이블 생성까지 약 1분 소요

## 2. Lambda IAM 역할에 DynamoDB 권한 추가

### 옵션 A: AWS 콘솔에서 추가

1. **IAM 콘솔 접속**
   - https://console.aws.amazon.com/iam/

2. **역할 찾기**
   - Roles → `book-debeach-lambda-role` 검색

3. **인라인 정책 추가**
   - Permissions 탭 → "Add permissions" → "Create inline policy"
   - JSON 탭 선택
   - 아래 정책 붙여넣기:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:PutItem",
        "dynamodb:Query",
        "dynamodb:GetItem"
      ],
      "Resource": "arn:aws:dynamodb:ap-south-1:106055905364:table/book-debeach-slot-claims"
    }
  ]
}
```

4. **정책 이름 입력**
   - Policy name: `DynamoDBSlotClaimsAccess`
   - "Create policy" 클릭

### 옵션 B: CLI로 추가 (권한이 있는 경우)

```bash
aws iam put-role-policy \
  --role-name book-debeach-lambda-role \
  --policy-name DynamoDBSlotClaimsAccess \
  --policy-document file:///Users/joonholee/Joon/1-Project/dev/book/lambda/doc/iam-policy.json
```

## 3. 테이블 생성 확인

```bash
# 테이블 존재 확인
aws dynamodb describe-table \
  --table-name book-debeach-slot-claims \
  --region ap-south-1

# TTL 설정 확인
aws dynamodb describe-time-to-live \
  --table-name book-debeach-slot-claims \
  --region ap-south-1
```

## 4. Lambda 배포

테이블 생성 및 권한 설정 완료 후:

```bash
cd /Users/joonholee/Joon/1-Project/dev/book/lambda/book-debeach
npm install
npm run build
aws lambda update-function-code \
  --function-name book-debeach \
  --zip-file fileb://deployment_package.zip \
  --region ap-south-1
```

## 문제 해결

### 권한 에러가 계속 발생하는 경우

Lambda 실행 시 DynamoDB 권한 에러가 발생하면:

1. Lambda 함수의 실행 역할 확인
   ```bash
   aws lambda get-function-configuration \
     --function-name book-debeach \
     --region ap-south-1 \
     --query 'Role'
   ```

2. 해당 역할에 DynamoDB 권한이 있는지 확인
   ```bash
   aws iam list-role-policies \
     --role-name book-debeach-lambda-role
   ```

3. 정책 내용 확인
   ```bash
   aws iam get-role-policy \
     --role-name book-debeach-lambda-role \
     --policy-name DynamoDBSlotClaimsAccess
   ```
