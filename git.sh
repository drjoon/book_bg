#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

info() {
  echo -e "\033[1;34m[INFO]\033[0m $1"
}

error() {
  echo -e "\033[1;31m[ERROR]\033[0m $1" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || error "git이 설치되어 있지 않습니다."

# 커밋 메시지: 인자로 전달하거나 입력받기
if [ $# -ge 1 ]; then
  MSG="$*"
else
  read -r -p "커밋 메시지: " MSG
  [ -z "$MSG" ] && error "커밋 메시지를 입력하세요."
fi

cd "$ROOT_DIR"

info "변경 사항 확인"
git status --short

info "전체 스테이징"
git add .

info "커밋: $MSG"
git commit -m "$MSG" || error "변경 사항이 없거나 커밋 실패"

info "push"
git push

info "완료"
