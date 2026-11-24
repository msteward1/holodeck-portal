#!/bin/bash
# Container start: first-run setup of the persistent volumes, nginx, then the portal (foreground).
set -euo pipefail
ETC=/etc/holodeck-portal
DATA=/var/lib/holodeck-portal
APP=/opt/holodeck-portal

: "${HP_HOSTNAME:?Set HP_HOSTNAME to the DNS name of the portal, e.g. holodeck.example.com}"
export HP_PUBLIC_URL="${HP_PUBLIC_URL:-https://${HP_HOSTNAME}}"
umask 077
mkdir -p "$ETC/ssl" "$DATA"

# TLS: a temporary self-signed certificate until one is provided in $ETC/ssl/portal.{crt,key}.
if [ ! -s "$ETC/ssl/portal.crt" ] || [ ! -s "$ETC/ssl/portal.key" ]; then
  echo "Creating a temporary self-signed certificate for ${HP_HOSTNAME}; replace $ETC/ssl/portal.crt/.key with a CA-issued one."
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 -keyout "$ETC/ssl/portal.key" -out "$ETC/ssl/portal.crt" \
    -subj "/CN=${HP_HOSTNAME}" -addext "subjectAltName=DNS:${HP_HOSTNAME}" 2>/dev/null
fi
chmod 644 "$ETC/ssl/portal.crt"

# Webtop gateway: the secret nginx presents to the portal's authorize endpoint.
[ -s "$ETC/webtop-gateway.token" ] || openssl rand -hex 32 > "$ETC/webtop-gateway.token"
printf 'proxy_set_header X-HP-Gateway-Token "%s";\n' "$(cat "$ETC/webtop-gateway.token")" > "$ETC/nginx-gateway-token.conf"

# Extra CA certificates the portal should trust (e.g. an internal IdP): PEM bundle at $ETC/extra-ca.pem.
if [ -s "$ETC/extra-ca.pem" ]; then export NODE_EXTRA_CA_CERTS="$ETC/extra-ca.pem"; fi

sed -e "s/__HOSTNAME__/${HP_HOSTNAME}/g" "$APP/deploy/nginx-holodeck-portal.conf" > /etc/nginx/conf.d/holodeck-portal.conf
nginx -t -q
# nginx in the background, restarted if it ever exits; the portal is the container's main process.
( while true; do nginx -g 'daemon off;' || true; sleep 2; done ) &

# PowerCLI from the data volume (downloaded on first start; see install-powercli.sh).
export PSModulePath="$HP_PS_MODULES${PSModulePath:+:$PSModulePath}"
"$APP/deploy/container/install-powercli.sh" >/dev/null 2>&1 &

cd "$APP/server"
exec node dist/index.js
