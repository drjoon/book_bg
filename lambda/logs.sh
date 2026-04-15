#!/usr/bin/env bash
# 4개 리전 Lambda 로그를 동시에 가져와 단일 파일로 병합 (시각 순 정렬)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$SCRIPT_DIR/doc"
OUTPUT="$LOG_DIR/lambda_today.log"
FUNCTION_NAME="book-debeach"
REGIONS=("ap-northeast-2" "ap-northeast-1" "ap-southeast-1" "ap-south-1")
REGION_LABELS=("서울" "도쿄" "싱가포르" "뭄바이")

# 기본값: 오늘 08:30 KST 이후
DEFAULT_HOUR=8
DEFAULT_MIN=30
HOUR="${1:-$DEFAULT_HOUR}"
MIN="${2:-$DEFAULT_MIN}"

START_MS=$(python3 -c "
import datetime, pytz
t = pytz.timezone('Asia/Seoul')
d = datetime.datetime.now(t).replace(hour=$HOUR, minute=$MIN, second=0, microsecond=0)
print(int(d.timestamp() * 1000))
")

echo "=== Fetching logs from ${#REGIONS[@]} regions since $(printf '%02d:%02d' $HOUR $MIN) KST ==="

pids=()
tmpfiles=()
for i in "${!REGIONS[@]}"; do
  REGION="${REGIONS[$i]}"
  LABEL="${REGION_LABELS[$i]}"
  TMP=$(mktemp)
  tmpfiles+=("$TMP")
  (
    aws logs filter-log-events \
      --log-group-name "/aws/lambda/$FUNCTION_NAME" \
      --start-time "$START_MS" \
      --region "$REGION" \
      --query 'events[*].message' \
      --output text > "$TMP" 2>&1
    COUNT=$(wc -l < "$TMP" | tr -d ' ')
    echo "  ✅ [$LABEL/$REGION] $COUNT lines"
  ) &
  pids+=($!)
done

for pid in "${pids[@]}"; do
  wait "$pid"
done

echo ""
echo "=== Merging and sorting by timestamp ==="

# 각 리전 로그를 합친 뒤 타임스탬프(ISO8601 접두어) 기준 정렬
cat "${tmpfiles[@]}" | sort > "$OUTPUT"

for tmp in "${tmpfiles[@]}"; do
  rm -f "$tmp"
done

TOTAL=$(wc -l < "$OUTPUT" | tr -d ' ')
echo "✅ Saved $TOTAL lines → $OUTPUT"
