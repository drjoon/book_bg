#!/bin/bash

# EBS 환경변수 완전 교체 스크립트
# 사용법: ./reset-env.sh
# 주의: AWS 크리덴셜이 필요합니다. aws configure로 설정하세요.

set -e

# 설정
ENV_NAME="book2"
REGION="ap-south-1"
ENV_FILE="./web/backend/.env"
AWS_PROFILE="abuts.fit"

export AWS_PROFILE

echo "🔄 EBS 환경변수 완전 교체 시작..."
echo "환경: $ENV_NAME"
echo "리전: $REGION"
echo "파일: $ENV_FILE"
echo "AWS 프로필: $AWS_PROFILE"

# AWS 크리덴셜 확인
if ! aws sts get-caller-identity &>/dev/null; then
    echo "❌ 오류: AWS 크리덴셜이 설정되지 않았습니다."
    echo "~/.aws/credentials 파일에서 프로필을 확인하세요:"
    echo "  cat ~/.aws/credentials"
    echo ""
    echo "또는 환경변수로 설정:"
    echo "  export AWS_ACCESS_KEY_ID=your_access_key"
    echo "  export AWS_SECRET_ACCESS_KEY=your_secret_key"
    exit 1
fi

CURRENT_USER=$(aws sts get-caller-identity --query 'Arn' --output text)
echo "✅ AWS 크리덴셜 확인 완료: $CURRENT_USER"

# 0. 환경이 Ready 상태가 될 때까지 대기
echo "⏳ 환경이 Ready 상태가 될 때까지 대기..."
MAX_WAIT=300  # 5분
ELAPSED=0
while [ $ELAPSED -lt $MAX_WAIT ]; do
    STATUS=$(aws elasticbeanstalk describe-environments \
        --environment-name "$ENV_NAME" \
        --region "$REGION" \
        --query 'Environments[0].Status' \
        --output text)
    
    if [ "$STATUS" = "Ready" ]; then
        echo "✅ 환경이 Ready 상태입니다."
        break
    fi
    
    echo "  현재 상태: $STATUS (대기 중...)"
    sleep 10
    ELAPSED=$((ELAPSED + 10))
done

if [ "$STATUS" != "Ready" ]; then
    echo "⚠️  경고: 환경이 Ready 상태가 아닙니다. 계속 진행합니다."
fi

# 1. 환경 업데이트 완료 대기
echo "⏳ 환경 업데이트 완료 대기..."
aws elasticbeanstalk wait environment-updated \
  --environment-name "$ENV_NAME" \
  --region "$REGION" || true

# 2. 현재 환경변수 모두 제거
echo "🗑️  기존 환경변수 모두 제거..."
aws elasticbeanstalk update-environment \
  --environment-name "$ENV_NAME" \
  --option-settings Namespace=aws:elasticbeanstalk:application:environment,OptionName=PARAM1,Value="" \
  --region "$REGION" || true

# 잠시 대기
sleep 5

# 2. 환경변수 파일 읽기 및 포맷팅
if [ ! -f "$ENV_FILE" ]; then
    echo "❌ 오류: $ENV_FILE 파일을 찾을 수 없습니다"
    exit 1
fi

echo "📖 환경변수 파일 읽기..."

# 3. 환경변수 설정 구성
echo "⚙️  환경변수 설정 구성..."
OPTION_SETTINGS=""
VAR_COUNT=0
MAX_VARS_PER_REQUEST=50

# 환경변수를 파라미터 이름으로 변환 (PARAM1, PARAM2, ...)
while IFS= read -r line; do
    # 빈 줄과 주석 제거
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    
    # = 기호가 있는 줄만 처리
    if [[ "$line" =~ = ]]; then
        VAR_COUNT=$((VAR_COUNT + 1))
        KEY=$(echo "$line" | cut -d'=' -f1)
        VALUE=$(echo "$line" | cut -d'=' -f2-)
        
        # 특수문자 이스케이프
        VALUE=$(echo "$VALUE" | sed 's/"/\\"/g')
        
        # 옵션 설정 추가
        OPTION_SETTINGS="$OPTION_SETTINGS Namespace=aws:elasticbeanstalk:application:environment,OptionName=$KEY,Value=\"$VALUE\" "
        
        echo "  PARAM$VAR_COUNT: $KEY=$VALUE"
        
        # 최대 개수에 도달하면 분리 전송
        if [ $((VAR_COUNT % MAX_VARS_PER_REQUEST)) -eq 0 ]; then
            echo "📤 $VAR_COUNT 개 변수 전송..."
            aws elasticbeanstalk update-environment \
                --environment-name "$ENV_NAME" \
                --option-settings $OPTION_SETTINGS \
                --region "$REGION"
            
            OPTION_SETTINGS=""
            sleep 2
        fi
    fi
done < "$ENV_FILE"

# 남은 변수들 전송
if [ -n "$OPTION_SETTINGS" ]; then
    echo "📤 남은 변수 전송..."
    aws elasticbeanstalk update-environment \
        --environment-name "$ENV_NAME" \
        --option-settings $OPTION_SETTINGS \
        --region "$REGION"
fi

# 4. 환경 업데이트 대기
echo "⏳ 환경 업데이트 대기..."
aws elasticbeanstalk wait environment-updated \
    --environment-name "$ENV_NAME" \
    --region "$REGION"

echo "✅ EBS 환경변수 교체 완료!"
echo "총 $VAR_COUNT 개 변수가 설정되었습니다."

# 5. 환경 상태 확인
echo "🔍 환경 상태 확인..."
aws elasticbeanstalk describe-environments \
    --environment-name "$ENV_NAME" \
    --region "$REGION" \
    --query "Environments[0].{Name:EnvironmentName,Status:Status,Health:Health}" \
    --output table
