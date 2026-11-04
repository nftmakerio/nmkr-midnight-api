#!/usr/bin/env bash
# Läuft alle 3 min. Prüft jede AKTIVE nmkr-api@-Instanz:
#  1) Ledger vergiftet? wallet/info (read-only, fester Dummy-Seed) -> "unreachable"  => sofort Neustart
#  2) Hänger? Dienst > 25 min aktiv und /api/health 3x hintereinander (je 60 s Timeout) fehlgeschlagen => Neustart
#     Wallet-Syncs blockieren den Event-Loop teils 20-30 s, daher großzügig.
declare -A PORT=([mainnet]=3003 [preview]=3002 [preprod]=3001)
SEED=$(printf 'ab%.0s' $(seq 64))
STATE=/run/nmkr-probe; mkdir -p $STATE
for net in "${!PORT[@]}"; do
  unit=nmkr-api@$net
  systemctl is-active --quiet $unit || { rm -f $STATE/$net.fails; continue; }
  port=${PORT[$net]}
  out=$(curl -s -m 20 -X POST "http://127.0.0.1:$port/api/wallet/info" \
        -H 'content-type: application/json' --data-binary "{\"seed\":\"$SEED\"}")
  if echo "$out" | grep -q '"error":"unreachable"'; then
    logger -t nmkr-probe "$net: LEDGER WASM POISONED -> restart"; systemctl restart $unit; rm -f $STATE/$net.fails; continue
  fi
  since=$(systemctl show -p ActiveEnterTimestamp --value $unit)
  age=$(( $(date +%s) - $(date -d "$since" +%s) ))
  if [ $age -lt 1500 ]; then rm -f $STATE/$net.fails; continue; fi
  if curl -s -m 60 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/health" | grep -q 200; then
    rm -f $STATE/$net.fails; continue
  fi
  n=$(( $(cat $STATE/$net.fails 2>/dev/null || echo 0) + 1 )); echo $n > $STATE/$net.fails
  if [ $n -ge 3 ]; then logger -t nmkr-probe "$net: HUNG (health failed ${n}x) -> restart"; systemctl restart $unit; rm -f $STATE/$net.fails
  else logger -t nmkr-probe "$net: health failed ($n/3)"; fi
done
