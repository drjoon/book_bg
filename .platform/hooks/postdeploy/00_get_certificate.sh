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

# 인증서 재발급은 최초 1회만 수행하되,
# 배포로 nginx 설정이 초기화될 수 있으므로 인증서가 이미 있어도 install 단계는 매번 수행한다.
if [ -d "/etc/letsencrypt/live/${DOMAIN}" ]; then
  echo "[INFO] Existing certificate found for ${DOMAIN}; reinstalling nginx TLS config."
  sudo certbot install --nginx -n --cert-name "${DOMAIN}" || true
else
  sudo certbot --nginx \
    -n \
    --agree-tos \
    --email "${EMAIL}" \
    -d "${DOMAIN}" || true
fi

echo "[INFO] Certificate hook completed for ${DOMAIN}."
