# Linux-Server-Setup (midnight-api)

Snapshot der Server-Konfiguration der Linux-VM, die seit 2026-10-19 den Windows-Server ersetzt.
Die Dateien hier sind Kopien – maßgeblich ist der Stand auf dem Server. **Keine Secrets:**
Configs (`config.<net>.json`) und die Paywindow-Secrets liegen nur auf dem Server.

Seit 2026-11-10 läuft mainnet auf dem **Ledger-9-Stack** (wallet-sdk 2 / facade 5, midnight-js 5,
ledger-v9, compact-runtime 0.21, Contracts mit compactc 0.36.0). Hintergrund: Midnight hat
mainnet/preprod/preview ~2026-11-07 auf Runtime 2001100 (Ledger 9) gehoben; der alte Stack kann
die neuen Events nicht mehr lesen.

## Server

- Ubuntu 26.04, 96 GB RAM, 16 Kerne (Xeon E5-2650 v3, Haswell – **ohne ADX**, siehe Proof-Server),
  Node 22 (NodeSource), Docker (`docker.io`), `qemu-user`
- Öffentliche IP 185.51.184.99 (80/443 weitergeleitet), ausgehend 185.51.184.9
- Benutzer `nmkr`, alles unter `/opt/nmkr` (700)

| Pfad auf dem Server | Hier |
|---|---|
| `/opt/nmkr/nmkr-api-mainnet` | Clone dieses Repos, Branch `main` (Ledger 9) |
| `/opt/nmkr/nmkr-api-{preview,preprod}` | Clones, noch auf dem Stand vor Ledger 9 (e26607b) |
| `/opt/nmkr/nmkr-api-v9` | Arbeits-Clone (Upgrade/Tests), preprod-Testinstanz lief von hier |
| `/opt/nmkr/nmkr-paywindow-{mainnet,preprod,preview}` | Clones von `nmkr-midnight-paywindow` |
| `/opt/nmkr/tools/compactc-0.36.0{,-emu}` | Compact-Compiler (siehe unten) |
| `/opt/nmkr/build/proof-server-emu` | Docker-Build des Proof-Servers = `proof-server/` |
| `/etc/systemd/system/` | `systemd/` |
| `/opt/nmkr/bin/` | `bin/` |
| `/etc/nginx/sites-available/nmkr-midnight` | `nginx/nmkr-midnight` |
| `/etc/nginx/nginx.conf` (Auszug: `server_names_hash_bucket_size 128;` + Timing-Log) | `nginx/nginx.conf.snippet` |
| `/etc/logrotate.d/nmkr` | `logrotate/` |
| `/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh` | `letsencrypt/` |
| `/etc/nmkr/paywindow-<net>.env` | `env/*.example` (Secret entfernt) |
| Logs | `/var/log/nmkr/` (`api-<net>.log`, `api-<net>.err.log`, `access/`), `/var/log/nginx/timing.log` |

## Dienste

| Unit | Port | Aktiv |
|---|---|---|
| `nmkr-api@mainnet` | 3003 | ja (Ledger 9) |
| `nmkr-api@preview` | 3002 | läuft noch auf dem alten Stack – kann nach dem Fork nicht mehr synchronisieren; preview wird nicht mehr genutzt |
| `nmkr-api@preprod` | 3001 | nein. Getestet wurde mit einer provisorischen Instanz (`nmkr-v9-test`, aus `nmkr-api-v9`), derzeit gestoppt |
| Docker `midnight-proof-server` | 127.0.0.1:6300 | ja (`nmkr/proof-server-emu:9.0.1`, `--restart unless-stopped`) |
| `nmkr-paywindow@mainnet` | 4100 → API 3003 | ja |
| `nmkr-paywindow@preprod` | 4101 → API 3002 (preview-API) | ja – 1:1 vom Windows-Server übernommen |
| `nmkr-paywindow@preview` | 4102 → API 3002 (preview-API), `NMKR_NETWORK=preprod` | ja – 1:1 vom Windows-Server übernommen |
| `nmkr-probe.timer` | – | alle 3 min |
| `nmkr-poison-watch@{mainnet,preview}` | – | ja |

Hinweis: Die öffentlichen Paywindow-Domains (`midnight-paywindow*.nmkr.io`) zeigen per DNS auf
NMKR-Infrastruktur (185.207.102.6), nicht auf diesen Server.

Wichtige Umgebung der API-Unit: `MIDNIGHT_CACHE_READONLY=true` (nur die ENV wirkt, nicht die Config),
`NODE_OPTIONS=--max-old-space-size=40960` (für den Ledger-9-Stack viel zu groß – die API braucht
im Betrieb ~0,5 GB; kann gesenkt werden).

Mainnet-Config: `proofServer` = `http://127.0.0.1:6300`, Indexer + Node-RPC über Blockfrost
(die öffentlichen Midnight-Indexer für preprod/preview wurden am 2026-10-09 abgeschaltet).

## Proof-Server und Compiler (CPU ohne ADX)

Der offizielle Proof-Server (`midnightntwrk/proof-server:9.0.1`) und `zkir-v3` aus compactc 0.36.0
nutzen ADX-Befehle und stürzen auf dieser CPU mit `invalid opcode` ab. Beide laufen deshalb
unverändert unter `qemu-user -cpu max` (Details und Build: `proof-server/README.md`).
Kosten: Faktor ~10 – ein Mint braucht ~85–100 s, davon ~70 s Beweise. Auf einem Host mit ADX
(Intel ab Broadwell, AMD ab Zen) das offizielle Image direkt verwenden.

Contracts neu kompilieren:
```
/opt/nmkr/tools/compactc-0.36.0-emu/compactc contracts/nmkr-mts.compact contracts/managed/nmkr-mts
```
`contracts/managed-ledger8/` enthält die alten Artefakte (compact-runtime 0.16, Import auf
`compact-runtime-ledger8` umgebogen). Damit werden Collections von vor dem Fork weiter bemintet
(Midnight.js „retained era“/keep-state; automatisch, wenn die Verifier-Keys nicht passen).

## Watchdogs

Die Wallet-Synchronisierung des alten Stacks traf auf Chain-Events, die das Ledger-WASM mit
`RuntimeError: unreachable` dauerhaft kaputt machten. Die Watchdogs bleiben aktiv:

- **`nmkr-poison-watch.sh`** folgt `api-<net>.err.log` und startet die API sofort neu, sobald
  `RuntimeError: unreachable` erscheint (nicht innerhalb von 60 s nach einem Start).
- **`nmkr-probe.sh`** (Timer): Neustart, wenn `POST /api/wallet/info` mit festem Dummy-Seed
  „unreachable“ liefert, oder wenn `/api/health` dreimal hintereinander nicht innerhalb von 60 s antwortet.

Der Wallet-State wird jede Minute gespeichert (`wallet-state-cache-<net>/`), ein Neustart setzt am
letzten Stand fort. Neue Dust-Wallets starten am Ledger-9-Fork (Fork-Punkt wird einmal gesucht und
in `dust-fork-start.<net>.json` gecacht).

## Logs und Diagnose

- `api-<net>.log`: Schreib-Aufrufe (`/api/nft/*`, Transfers, Dust-Registrierung) loggen `START`,
  Schritt-Zeiten (`[trace mint …] +41.1s contract proof done …`) und `CLIENT ABORTED`, wenn der
  Aufrufer vor dem Ende aufgibt (der Aufruf läuft dann weiter).
- `/var/log/nginx/timing.log`: Host, Upstream, Status und Dauer je Request – zeigt z. B., an welche
  Netz-Domain ein Aufrufer tatsächlich sendet.
- Mints sind idempotent: gleicher Mint (Collection + Name + `uri` + Bild) hängt sich an einen
  laufenden Aufruf an; ein bereits erledigter wird mit **409** abgelehnt
  (`mints-done.<net>.json` im Clone, nicht im Git).

## Zertifikate

Let's Encrypt per Webroot (`/var/www/acme-challenge`), erstmalig mit `bin/issue-certs.sh <email>`
ausgestellt; danach erneuert der certbot-Timer automatisch, der Deploy-Hook lädt nginx neu.
Das Mainnet-Zertifikat deckt `midnight-api.mainnet.nmkr.io` und `midnight-api.nmkr.io` ab.

## Neu aufsetzen (Kurzfassung)

1. Benutzer `nmkr`, Node 22, nginx, certbot, `docker.io`, `qemu-user` installieren; Repo nach
   `/opt/nmkr` clonen (Branch `main`), `npm ci` als `nmkr`.
2. Proof-Server bauen und starten (`proof-server/README.md`; mit ADX-CPU das offizielle Image).
3. `config.<net>.json` und `/etc/nmkr/paywindow-<net>.env` aus dem Secret-Archiv einspielen.
4. Dateien aus diesem Ordner an die Pfade oben kopieren, `systemctl daemon-reload`,
   Units aktivieren (`enable --now`), nginx testen und neu laden.
5. Zertifikate erst ausstellen, wenn DNS/Portweiterleitung auf den Server zeigt.

Nie `/api/watch/rebuild-cache` aufrufen. `/api/health` und `/api/version` geben den Blockfrost-Key aus –
Ausgaben davon nicht weitergeben. In den Server-Clones nie `git commit -a`: die `config.*.json`
sind versioniert (Vorlagen) und lokal mit Secrets überschrieben.
