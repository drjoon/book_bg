#!/usr/bin/env bash
set -euo pipefail

DOMAIN="book.ap-south-1.elasticbeanstalk.com"
EMAIL="drjoon@gmail.com"

echo "[INFO] Ensuring TLS for ${DOMAIN}..."

# 패키지 설치는 certbot이 없을 때만 (매 배포 dnf는 t4g.micro에서 배포를 멈추게 함)
if ! command -v certbot >/dev/null 2>&1; then
  echo "[INFO] certbot not found; installing once."
  if command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y certbot python3-certbot-nginx || true
  elif command -v yum >/dev/null 2>&1; then
    sudo yum install -y certbot python3-certbot-nginx || true
  fi
fi

# 배포로 nginx 설정이 초기화될 수 있어, 기존 인증서가 있으면 TLS만 다시 연결한다.
if [ -d "/etc/letsencrypt/live/${DOMAIN}" ]; then
  echo "[INFO] Existing certificate found; reinstalling nginx TLS config."
  sudo certbot install --nginx -n --cert-name "${DOMAIN}" || true
elif command -v certbot >/dev/null 2>&1; then
  echo "[INFO] No certificate yet; issuing once."
  sudo certbot --nginx -n --agree-tos --email "${EMAIL}" -d "${DOMAIN}" || true
else
  echo "[WARN] certbot unavailable; skipping TLS setup."
fi

# 갱신 cron은 없을 때만 생성
if [ ! -f /etc/cron.d/certbot-renew ]; then
  echo "0 3 * * * root certbot renew --quiet --post-hook 'systemctl reload nginx'" | sudo tee /etc/cron.d/certbot-renew >/dev/null
  sudo chmod 644 /etc/cron.d/certbot-renew
  echo "[INFO] Created certbot renew cron."
fi

echo "[INFO] Certificate hook completed for ${DOMAIN}."
