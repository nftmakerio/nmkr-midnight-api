# Linux-Server-Setup (midnight-api)

Snapshot der Server-Konfiguration der Linux-VM, die seit 2026-10-19 den Windows-Server ersetzt.
Die Dateien hier sind Kopien – maßgeblich ist der Stand auf dem Server. **Keine Secrets:**
Configs (`config.<net>.json`) und die Paywindow-Secrets liegen nur auf dem Server.

## Server

- Ubuntu 26.04, 96 GB RAM, 16 Kerne, Node 22 (NodeSource)
- Öffentliche IP 185.51.184.99 (80/443 weitergeleitet), ausgehend 185.51.184.9
- Benutzer `nmkr`, alles unter `/opt/nmkr` (700)

| Pfad auf dem Server | Hier |
|---|---|
| `/opt/nmkr/nmkr-api-{mainnet,preview,preprod}` | Clones dieses Repos, Branch `main` (bis 2026-11-04: `mts-native-nft`) |
| `/opt/nmkr/nmkr-paywindow-{mainnet,preprod,preview}` | Clones von `nmkr-midnight-paywindow` |
| `/etc/systemd/system/` | `systemd/` |
| `/opt/nmkr/bin/` | `bin/` |
| `/etc/nginx/sites-available/nmkr-midnight` (+ `server_names_hash_bucket_size 128;` in `nginx.conf`) | `nginx/` |
| `/etc/logrotate.d/nmkr` | `logrotate/` |
| `/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh` | `letsencrypt/` |
| `/etc/nmkr/paywindow-<net>.env` | `env/*.example` (Secret entfernt) |
| Logs | `/var/log/nmkr/` (`api-<net>.log`, `api-<net>.err.log`, `access/`) |

## Dienste

| Unit | Port | Aktiv |
|---|---|---|
| `nmkr-api@mainnet` | 3003 | ja |
| `nmkr-api@preview` | 3002 | ja |
| `nmkr-api@preprod` | 3001 | **nein** (Heap: 2×40 GB passen, eine dritte Instanz nur mit kleinerem Heap) |
| `nmkr-paywindow@mainnet` | 4100 → API 3003 | ja |
| `nmkr-paywindow@preprod` | 4101 → API 3002 (preview-API) | ja – 1:1 vom Windows-Server übernommen |
| `nmkr-paywindow@preview` | 4102 → API 3002 (preview-API), `NMKR_NETWORK=preprod` | ja – 1:1 vom Windows-Server übernommen |
| `nmkr-probe.timer` | – | alle 3 min |
| `nmkr-poison-watch@{mainnet,preview}` | – | ja |

Wichtige Umgebung der API-Unit: `MIDNIGHT_CACHE_READONLY=true` (nur die ENV wirkt, nicht die Config),
`NODE_OPTIONS=--max-old-space-size=40960`.

## Watchdogs

Die Wallet-Synchronisierung trifft auf Chain-Events, die das Ledger-WASM mit `RuntimeError: unreachable`
dauerhaft kaputt machen; danach schlägt jeder Ledger-Aufruf im Prozess fehl, bis die API neu startet.

- **`nmkr-poison-watch.sh`** folgt `api-<net>.err.log` und startet die API sofort neu, sobald
  `RuntimeError: unreachable` erscheint (nicht innerhalb von 60 s nach einem Start).
- **`nmkr-probe.sh`** (Timer): Neustart, wenn `POST /api/wallet/info` mit festem Dummy-Seed
  „unreachable“ liefert, oder wenn `/api/health` dreimal hintereinander nicht innerhalb von 60 s antwortet
  (der Sync blockiert die Event-Loop nach dem Start 20–30 s).

Seit `e85d5fb` wird der Wallet-State auch vor dem vollständigen Sync gespeichert, ein Neustart
setzt also am letzten Stand fort.

## Zertifikate

Let's Encrypt per Webroot (`/var/www/acme-challenge`), erstmalig mit `bin/issue-certs.sh <email>`
ausgestellt; danach erneuert der certbot-Timer automatisch, der Deploy-Hook lädt nginx neu.
Das Mainnet-Zertifikat deckt `midnight-api.mainnet.nmkr.io` und `midnight-api.nmkr.io` ab.

## Neu aufsetzen (Kurzfassung)

1. Benutzer `nmkr`, Node 22, nginx, certbot installieren; Repos nach `/opt/nmkr` clonen, `npm ci` als `nmkr`.
2. `config.<net>.json` und `/etc/nmkr/paywindow-<net>.env` aus dem Secret-Archiv einspielen.
3. Dateien aus diesem Ordner an die Pfade oben kopieren, `systemctl daemon-reload`,
   Units aktivieren (`enable --now`), nginx testen und neu laden.
4. Zertifikate erst ausstellen, wenn DNS/Portweiterleitung auf den Server zeigt.

Nie `/api/watch/rebuild-cache` aufrufen. `/api/health` und `/api/version` geben den Blockfrost-Key aus –
Ausgaben davon nicht weitergeben.
