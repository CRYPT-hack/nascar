#!/usr/bin/env bash
# Self-signed TLS for the venue LAN.
#
# Mobile browsers only expose motion sensors in a secure context, so a phone
# controller on http://192.168.x.x loads fine and then never receives a single
# sensor reading. This mints a certificate covering localhost and every LAN
# address this machine currently has, so the phone can reach the server by IP.
#
# The certificate is self-signed: each phone shows a warning once and the player
# taps through. Nothing here is trusted by anything, and certs/ is gitignored.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p certs

ALTS="DNS:localhost,IP:127.0.0.1"
for ip in $(hostname -I 2>/dev/null || ipconfig getifaddr en0 2>/dev/null || true); do
  ALTS="$ALTS,IP:$ip"
done
echo "certificate will cover: $ALTS"

openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout certs/dev-key.pem -out certs/dev-cert.pem \
  -subj "/CN=interlagos-racer" \
  -addext "subjectAltName=$ALTS" 2>/dev/null

echo "wrote certs/dev-key.pem and certs/dev-cert.pem"
echo "restart the server; it will serve https and phone sensors will work."
