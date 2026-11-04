#!/usr/bin/env bash
# Wächter für nmkr-api@<net>: Sobald im Fehler-Log "RuntimeError: unreachable" erscheint, ist das
# Ledger-WASM des Prozesses vergiftet (jeder Ledger-Aufruf scheitert bis zum Neustart).
# -> sofort neu starten, statt auf den 3-min-Probe zu warten. Cooldown 60 s gegen Neustart-Schleifen.
net=${1:?Netz angeben}; unit=nmkr-api@$net; log=/var/log/nmkr/api-$net.err.log
touch "$log"
tail -F -n0 "$log" 2>/dev/null | grep --line-buffered -F 'RuntimeError: unreachable' | while read -r _; do
  systemctl is-active --quiet $unit || continue
  since=$(systemctl show -p ActiveEnterTimestamp --value $unit)
  [ $(( $(date +%s) - $(date -d "$since" +%s) )) -lt 60 ] && continue
  logger -t nmkr-poison-watch "$net: RuntimeError unreachable im Log -> restart"
  systemctl restart $unit
done
