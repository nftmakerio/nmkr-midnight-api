#!/usr/bin/env bash
# Stellt die Let's-Encrypt-Zertifikate aus und stellt nginx darauf um (LINUX-MIGRATION.md §8 Schritt 2).
# ERST AUSFÜHREN, wenn 185.51.184.99:80/443 auf diese VM zeigt.  Aufruf: sudo /opt/nmkr/bin/issue-certs.sh <email>
set -euo pipefail
EMAIL=${1:?E-Mail fuer LetsEncrypt angeben}
SITE=/etc/nginx/sites-available/nmkr-midnight
issue() { certbot certonly --webroot -w /var/www/acme-challenge --non-interactive --agree-tos -m "$EMAIL" --keep-until-expiring "$@"; }
for d in midnight-api.preprod.nmkr.io midnight-api.preview.nmkr.io \
         midnight-paywindow.nmkr.io midnight-paywindow-api.nmkr.io \
         midnight-paywindow.preprod.nmkr.io midnight-paywindow-api.preprod.nmkr.io \
         midnight-paywindow.preview.nmkr.io midnight-paywindow-api.preview.nmkr.io; do
  issue -d $d
done
issue --cert-name midnight-api.mainnet.nmkr.io -d midnight-api.mainnet.nmkr.io -d midnight-api.nmkr.io
# Windows-Dateiname -> certbot-Name
declare -A MAP=(
  [mainnet]=midnight-api.mainnet.nmkr.io [preprod]=midnight-api.preprod.nmkr.io [preview]=midnight-api.preview.nmkr.io
  [paywindow-mainnet]=midnight-paywindow.nmkr.io [paywindow-preprod]=midnight-paywindow.preprod.nmkr.io
  [paywindow-preview]=midnight-paywindow.preview.nmkr.io [paywindow-api-mainnet]=midnight-paywindow-api.nmkr.io
  [paywindow-api-preprod]=midnight-paywindow-api.preprod.nmkr.io [paywindow-api-preview]=midnight-paywindow-api.preview.nmkr.io)
cp -a $SITE $SITE.bak-$(date +%Y%m%d-%H%M%S)
for k in "${!MAP[@]}"; do
  sed -i -e "s#/etc/nginx/ssl/$k-fullchain.pem;#/etc/letsencrypt/live/${MAP[$k]}/fullchain.pem;#" \
         -e "s#/etc/nginx/ssl/$k-privkey.pem;#/etc/letsencrypt/live/${MAP[$k]}/privkey.pem;#" $SITE
done
grep -n 'ssl_certificate' $SITE
nginx -t && systemctl reload nginx
systemctl list-timers --no-pager | grep -i certbot
