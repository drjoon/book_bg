#!/usr/bin/env bash
# Lambda 빌드 & 4개 리전 동시 배포
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAMBDA_DIR="$SCRIPT_DIR/book-debeach"
ZIP="$LAMBDA_DIR/deployment_package.zip"
FUNCTION_NAME="book-debeach"
REGIONS=("ap-northeast-2" "ap-northeast-1" "ap-southeast-1" "ap-south-1")
REGION_LABELS=("서울" "도쿄" "싱가포르" "뭄바이")

echo "=== [1/2] Building ==="
(cd "$LAMBDA_DIR" && npm run build)
echo "✅ Build complete: $ZIP"

echo ""
echo "=== [2/2] Deploying to ${#REGIONS[@]} regions in parallel ==="

pids=()
for i in "${!REGIONS[@]}"; do
  REGION="${REGIONS[$i]}"
  LABEL="${REGION_LABELS[$i]}"
  (
    ARN=$(aws lambda update-function-code \
      --function-name "$FUNCTION_NAME" \
      --zip-file "fileb://$ZIP" \
      --region "$REGION" \
      --query 'FunctionArn' \
      --output text 2>&1)
    if [ $? -eq 0 ]; then
      echo "  ✅ [$LABEL] $ARN"
    else
      echo "  ❌ [$LABEL/$REGION] $ARN" >&2
      exit 1
    fi
  ) &
  pids+=($!)
done

# 모든 병렬 작업 대기 및 결과 수집
failed=0
for pid in "${pids[@]}"; do
  wait "$pid" || failed=$((failed + 1))
done

echo ""
if [ "$failed" -eq 0 ]; then
  echo "🎉 Deployed to all ${#REGIONS[@]} regions successfully."
else
  echo "⚠️  $failed region(s) failed." >&2
  exit 1
fi
