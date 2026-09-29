#!/usr/bin/env bash
set -euo pipefail

DOMAIN="book.ap-south-1.elasticbeanstalk.com"
EMAIL="drjoon@gmail.com"
CERT="/etc/letsencrypt/live/${DOMAIN}/cert.pem"
WEBROOT="/var/www/letsencrypt"
RENEW_WITHIN_SECONDS=$((30 * 24 * 60 * 60))

echo "[INFO] Ensuring TLS for ${DOMAIN}..."

if ! command -v certbot >/dev/null 2>&1; then
  echo "[INFO] certbot not found; installing once."
  if command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y certbot python3-certbot-nginx
  elif command -v yum >/dev/null 2>&1; then
    sudo yum install -y certbot python3-certbot-nginx
  fi
fi

if ! command -v certbot >/dev/null 2>&1; then
  echo "[WARN] certbot unavailable; skipping TLS setup."
  exit 0
fi

sudo mkdir -p "${WEBROOT}/.well-known/acme-challenge"
echo ping | sudo tee "${WEBROOT}/.well-known/acme-challenge/ping" >/dev/null

if ! curl -fsS --max-time 10 -H "Host: ${DOMAIN}" "http://127.0.0.1/.well-known/acme-challenge/ping" | grep -q ping; then
  echo "[ERROR] Port 80 is not serving the ACME webroot." >&2
  exit 1
fi
echo "[INFO] ACME webroot is reachable."

need_renew=0
if [ ! -f "${CERT}" ]; then
  need_renew=1
elif ! sudo openssl x509 -checkend "${RENEW_WITHIN_SECONDS}" -noout -in "${CERT}" >/dev/null 2>&1; then
  echo "[INFO] Certificate expired or expires within 30 days."
  need_renew=1
else
  echo "[INFO] Certificate still valid for more than 30 days."
fi

if [ "${need_renew}" -eq 1 ]; then
  echo "[INFO] Renewing certificate via webroot..."
  set +e
  sudo timeout 240 certbot certonly \
    --webroot -w "${WEBROOT}" \
    --cert-name "${DOMAIN}" \
    -d "${DOMAIN}" \
    --force-renewal \
    -n --agree-tos --email "${EMAIL}"
  rc=$?
  set -e
  if [ "${rc}" -ne 0 ]; then
    echo "[ERROR] certbot failed with exit ${rc}" >&2
    sudo tail -n 160 /var/log/letsencrypt/letsencrypt.log >&2 || true
    exit "${rc}"
  fi
fi

echo "[INFO] Installing certificate into nginx."
sudo certbot install --nginx -n --cert-name "${DOMAIN}"

# AL2023 certbot 패키지는 갱신 타이머를 기본 기동하지 않는다. cron.d만으로는 갱신이 실행되지 않는다.
if [ -f /usr/lib/systemd/system/certbot-renew.timer ] || [ -f /lib/systemd/system/certbot-renew.timer ]; then
  sudo systemctl enable --now certbot-renew.timer
  echo "[INFO] certbot-renew.timer enabled."
fi

echo "[INFO] Certificate hook completed for ${DOMAIN}."
