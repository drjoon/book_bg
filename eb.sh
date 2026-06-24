#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$ROOT_DIR/web/frontend"
BACKEND_DIR="$ROOT_DIR/web/backend"
DIST_DIR="$FRONTEND_DIR/dist"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
ZIP_NAME="deploy-$TIMESTAMP.zip"
ZIP_PATH="$ROOT_DIR/$ZIP_NAME"

info() { echo -e "\033[1;34m[INFO]\033[0m $1"; }
error() { echo -e "\033[1;31m[ERROR]\033[0m $1" >&2; exit 1; }

command -v eb >/dev/null 2>&1 || error "Elastic Beanstalk CLI(eb)가 설치되어 있지 않습니다."

info "프론트엔드 빌드"
(cd "$FRONTEND_DIR" && npm install && npm run build)

info "백엔드 의존성 설치 (production)"
(cd "$BACKEND_DIR" && npm install --omit=dev)

info "이전 zip 정리"
find "$ROOT_DIR" -maxdepth 1 -name 'deploy-*.zip' -type f -mtime +3 -delete || true

info "zip 패키지 생성"
cat <<'EOF' > "$ROOT_DIR/.ebignore"
.git
node_modules
web/backend/node_modules
web/frontend/node_modules
web/frontend/src
web/frontend/public
*.zip
.DS_Store
*.env
.elasticbeanstalk/*
!.elasticbeanstalk/*.cfg.yml
!.elasticbeanstalk/*.global.yml
EOF

rm -f "$ZIP_PATH"
(cd "$ROOT_DIR" && zip -r "$ZIP_NAME" . \
  -x "*.git*" \
  -x "*node_modules/*" \
  -x "*deploy-*.zip" \
  -x ".elasticbeanstalk/logs/*" \
  -x ".elasticbeanstalk/logs/**")

info "zip에 dist 포함"
(cd "$FRONTEND_DIR" && zip -ur "$ZIP_PATH" dist)

info "EB 배포"
eb deploy --staged --label "$TIMESTAMP" --message "Deploy $TIMESTAMP" || error "eb deploy 실패"

info "배포 완료: $ZIP_PATH"
