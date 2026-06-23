#!/usr/bin/env bash
# 7개 리전 Lambda 로그를 동시에 가져와 단일 파일로 병합 (시각 순 정렬)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$SCRIPT_DIR/doc"
OUTPUT="$LOG_DIR/lambda_today.log"
FUNCTION_NAME="book-debeach"
REGIONS=("ap-northeast-2" "ap-northeast-1" "ap-northeast-3" "ap-southeast-1" "ap-east-1" "ap-east-2" "ap-southeast-7")
REGION_LABELS=("서울" "도쿄" "오사카" "싱가포르" "홍콩" "타이페이" "방콕")

# 기본값: 오늘 08:30 KST
DEFAULT_HOUR=8
DEFAULT_MIN=30
HOUR="${1:-$DEFAULT_HOUR}"
MIN="${2:-$DEFAULT_MIN}"

# 입력값 검증
if ! [[ "$HOUR" =~ ^[0-9]{1,2}$ ]] || ! [[ "$MIN" =~ ^[0-9]{1,2}$ ]]; then
  echo "❌ Usage: ./logs.sh [HOUR(0-23)] [MIN(0-59)]"
  exit 1
fi
if (( HOUR < 0 || HOUR > 23 || MIN < 0 || MIN > 59 )); then
  echo "❌ Invalid time: $(printf '%02d:%02d' "$HOUR" "$MIN")"
  exit 1
fi

# 오늘 KST 기준 시작 시각(epoch ms) 계산
TODAY_KST="$(TZ=Asia/Seoul date +%Y-%m-%d)"
TIME_KST="$(printf '%02d:%02d:00' "$HOUR" "$MIN")"

# macOS(BSD date) 우선
if START_S=$(TZ=Asia/Seoul date -j -f "%Y-%m-%d %H:%M:%S" "$TODAY_KST $TIME_KST" +%s 2>/dev/null); then
  :
# Linux(GNU date) fallback
elif START_S=$(TZ=Asia/Seoul date -d "$TODAY_KST $TIME_KST" +%s 2>/dev/null); then
  :
else
  echo "❌ Failed to calculate start timestamp. Unsupported 'date' command on this system."
  exit 1
fi

START_MS=$((START_S * 1000))

echo "=== Fetching logs from ${#REGIONS[@]} regions since $(printf '%02d:%02d' $HOUR $MIN) KST ==="

pids=()
tmpfiles=()
for i in "${!REGIONS[@]}"; do
  REGION="${REGIONS[$i]}"
  LABEL="${REGION_LABELS[$i]}"
  TMP=$(mktemp)
  tmpfiles+=("$TMP")
  (
    ERRTMP=$(mktemp)
    if aws logs filter-log-events \
        --log-group-name "/aws/lambda/$FUNCTION_NAME" \
        --start-time "$START_MS" \
        --region "$REGION" \
        --query 'events[*].message' \
        --output text > "$TMP" 2>"$ERRTMP"; then
      COUNT=$(wc -l < "$TMP" | tr -d ' ')
      echo "  ✅ [$LABEL/$REGION] $COUNT lines"
    else
      if grep -q "ResourceNotFoundException" "$ERRTMP"; then
        echo "  ⚠️  [$LABEL/$REGION] 로그 그룹 없음 (Lambda 미호출)"
      else
        echo "  ❌ [$LABEL/$REGION] 오류: $(cat "$ERRTMP")"
      fi
      > "$TMP"
    fi
    rm -f "$ERRTMP"
  ) &
  pids+=($!)
done

for pid in "${pids[@]}"; do
  wait "$pid" || true
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
