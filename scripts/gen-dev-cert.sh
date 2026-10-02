#!/bin/sh
# Certificat auto-signé et clé maître POUR LE DÉVELOPPEMENT UNIQUEMENT (jamais en production).
# Usage : scripts/gen-dev-cert.sh [dossier]   (défaut : .dev, ignoré par git)
set -eu
DIR="${1:-.dev}"
mkdir -p "$DIR"
umask 077
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 30 \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -keyout "$DIR/dev-key.pem" -out "$DIR/dev-cert.pem" 2>/dev/null
if [ ! -f "$DIR/master.key" ]; then
  openssl rand -base64 32 > "$DIR/master.key"
fi
echo "Certificat de développement créé dans $DIR (valable 30 jours)."
