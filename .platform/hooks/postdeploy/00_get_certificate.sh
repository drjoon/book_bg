#!/usr/bin/env bash
set -euo pipefail

DOMAIN="book.ap-south-1.elasticbeanstalk.com"
EMAIL="drjoon@gmail.com"  # TODO: 실제 이메일로 교체

echo "[INFO] Requesting/renewing certificate for ${DOMAIN}..."

# Certbot & nginx plugin 설치 (AL2023 기준 dnf, 이전 세대는 yum)
if command -v dnf >/dev/null 2>&1; then
  sudo dnf install -y certbot python3-certbot-nginx || true
elif command -v yum >/dev/null 2>&1; then
  sudo yum install -y certbot python3-certbot-nginx || true
fi

# 배포마다 certbot --nginx를 강제 실행하면 nginx reload/restart로
# PM2 프로세스(예약 워커 포함)에 영향을 줄 수 있어 최초 1회만 발급.
if [ -d "/etc/letsencrypt/live/${DOMAIN}" ]; then
  echo "[INFO] Existing certificate found for ${DOMAIN}; skipping issue step."
else
  sudo certbot --nginx \
    -n \
    --agree-tos \
    --email "${EMAIL}" \
    -d "${DOMAIN}" || true
fi

echo "[INFO] Certificate hook completed for ${DOMAIN}."
