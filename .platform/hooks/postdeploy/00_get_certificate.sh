#!/usr/bin/env bash
set -euo pipefail

DOMAIN="golf-book.ap-northeast-2.elasticbeanstalk.com"
EMAIL="drjoon@gmail.com"  # TODO: 실제 이메일로 교체

echo "[INFO] Requesting/renewing certificate for ${DOMAIN}..."

# Certbot & nginx plugin 설치 (AL2023 기준 dnf, 이전 세대는 yum)
if command -v dnf >/dev/null 2>&1; then
  sudo dnf install -y certbot python3-certbot-nginx || true
elif command -v yum >/dev/null 2>&1; then
  sudo yum install -y certbot python3-certbot-nginx || true
fi

# 인증서 발급 또는 갱신 + nginx 설정 자동 반영
sudo certbot --nginx \
  -n \
  --agree-tos \
  --email "${EMAIL}" \
  -d "${DOMAIN}"

echo "[INFO] Certificate for ${DOMAIN} installed and nginx reloaded."
