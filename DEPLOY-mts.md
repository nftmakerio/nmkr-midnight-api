# Deploy: MTS-NFT-Flow auf den Produktiv-Server

Branch: `mts-native-nft` — bringt den MTS-NFT-Flow (nativer Shielded-Token +
on-chain Metadata, rendert im 1AM-Wallet) und den Mainnet-Deploy-Fix.

## Was der Branch enthält (2 Commits, 19 Dateien, keine neuen Dependencies)

- `contracts/nmkr-mts.compact` — Contract-Quelle
- `contracts/managed/nmkr-mts/` — kompiliertes Artefakt inkl. ZK-Keys
  (`keys/mint.prover` ~10 MB, im Git eingecheckt, kein LFS)
- `src/api/midnight-service.ts` — MTS-Funktionen + Network-ID-Fix
- `src/api/server.ts` — Endpoints auf MTS umgestellt

**`package.json` / Lockfile unverändert → `npm ci` nur nötig, wenn `node_modules`
fehlt.** Der `git pull` bringt die ZK-Keys automatisch mit.

### Der Fix (commit `50e9f5b`)

`resolveShieldedAddress()` schrieb `parsed.network` in die SDK-globale Network-ID.
`MidnightBech32m.parse()` liefert für **Mainnet**-Adressen ein `Symbol(Mainnet)`
(auf preview/preprod einen String). Das Symbol floss in `getNetworkId()` beim
Deploy → `passStringToWasm0(Symbol)` rechnet `NaN` als Länge → ledger-v8-wasm
crasht mit `memory access out of bounds`. Fix: Network-ID snapshotten/restoren
statt überschreiben, plus `setNetworkId(cfg.networkId)` vor dem Deploy.
Kein Speicher-/AVX-/Skalenproblem — reiner Typ-Leak.

## Geänderte Endpoint-Semantik (bewusst — der funktionierende Flow)

- `POST /api/nft/mint` → immer MTS.
  Felder: `{ownerSeed, name, image (ipfs://…), toShieldedAddress, symbol?,
  description?, collection?, contractAddress?, dustSeed?}`.
  Ohne `contractAddress`: neue Collection wird deployt. Mit: in bestehende minten.
  Response: `{contractAddress, tokenId (=64-hex Colour), tokenType, txHash,
  deployTxHash, newCollection, ownerSeed}`.
- `POST /api/nft/create-collection` → `deployMtsCollection` (deploy-only).
- `POST /api/nft/transfer` → nativer Shielded-Token-Send, `tokenId` = Colour.
- Neu: `POST /api/nft/send-native`.

Voraussetzung für jeden Mint: **Dust am Mint-Wallet** (`ownerSeed`/`dustSeed`).

---

## Schritt 1 — Code holen (zuerst auf der **preprod**-Instanz)

```bash
cd <repo-verzeichnis-des-preprod-service>
git fetch origin
git checkout mts-native-nft        # oder: in euren Deploy-Branch mergen
git rev-parse HEAD                  # muss 50e9f5b… zeigen
# nur falls node_modules fehlt/inkonsistent:
# npm ci
```

## Schritt 2 — preprod-Service neu starten

Prüfen, wie der Dienst läuft, dann neu starten:

```bash
systemctl list-units | grep -i midnight    # oder: pm2 list   /   docker ps
sudo systemctl restart <midnight-preprod-service>   # systemd
# pm2 restart <preprod-app-name>                    # pm2
# docker compose restart <preprod-service>          # docker
```

Env unverändert (`MIDNIGHT_NETWORK=preprod` + Blockfrost-Feed sind gesetzt).

## Schritt 3 — Deploy verifizieren

```bash
curl -s https://midnight-api.preprod.nmkr.io/api/health     # 200
git -C <repo> rev-parse HEAD                                 # 50e9f5b…
```

> `/api/version` bleibt `1.1.0` (Version-String unverändert) — Code-Stand am
> sichersten über `git rev-parse HEAD` prüfen. Optional `version` in
> `package.json` bumpen, um den Stand am Endpoint sichtbar zu machen.

## Schritt 4 — preprod-MTS-Mint testen

```bash
curl -s -X POST https://midnight-api.preprod.nmkr.io/api/nft/mint \
  -H 'content-type: application/json' \
  -d '{
    "ownerSeed": "<PREPROD_MINT_WALLET_SEED>",
    "collection": "Waldshut Collection",
    "name": "Waldshut Motiv 1",
    "symbol": "WALD",
    "image": "ipfs://QmZxoM7adkiEZABDvkf51fnaKds7oehf9W3cFLRPYhopX9",
    "mediaType": "image/png",
    "toShieldedAddress": "<PREPROD_EMPFAENGER_SHIELDED_ADDR>"
  }'
```

Erwartung: JSON mit `contractAddress`, `tokenId`, `txHash`, `deployTxHash`.
NFT erscheint nach ein paar Sekunden im 1AM-Wallet der Empfängeradresse.

## Schritt 5 — auf **mainnet** ausrollen (erst wenn preprod sauber läuft)

Gleiche Schritte auf der mainnet-Instanz, dann derselbe `curl` gegen
`https://midnight-api.mainnet.nmkr.io/api/nft/mint` mit Mainnet-Mint-Wallet +
Mainnet-Empfänger.

**Hier zeigt sich, ob Blockfrosts Mainnet-Node die Submission annimmt.** Gute
Chancen: Der preprod-MTS-Mint lief bereits erfolgreich über **denselben
Blockfrost-Anbieter**, d.h. dessen Node akzeptiert Submissions (im Gegensatz zum
offiziellen Read-Node, der lokal mit `1016 pool limit` verwarf).

## Verify on-chain (optional, Blockfrost)

Nach dem Mint die Contract-Adresse gegen den Blockfrost-Indexer prüfen bzw. im
1AM-Wallet der Empfängeradresse ansehen. `contractAddress` + `txHash` aus der
Mint-Response verwenden.

## Hinweise

- **Proof-Server-Version MUSS zur ledger-v8-Version passen** (kritisch!). Ein
  Mismatch (z. B. Proof-Server 8.0.3 ↔ ledger-v8 8.1.2) führt beim Submit zu
  `1010 Invalid Transaction: Custom error 170` = `InvalidDustSpendProof` (der
  Node lehnt den Dust-Spend-Proof wegen veralteten Key-Materials ab). Für
  ledger-v8 8.1.x den Proof-Server **8.1.3** nutzen
  (`midnightntwrk/proof-server:8.1.3 -- midnight-proof-server --network mainnet`).
  Der erste erfolgreiche Mainnet-Mint (2026-10-05) lief genau mit dieser Kombi.
- **Proof-Backend des Servers:** Der Produktiv-Server zeigt auf `api.1am.xyz`.
  Unbedingt sicherstellen, dass dieses Backend **version-gematcht (≥8.1.x)** ist
  — sonst dort ebenfalls Error 170. Im Zweifel einen eigenen
  `midnightntwrk/proof-server:8.1.3` fahren und `MIDNIGHT_PROOF_SERVER` darauf
  zeigen (läuft auch ohne AVX-512).
- **Mainnet-Contracts:** seit ~2026-10-04 freigeschaltet (davor `1016 pool
  limit` = Deploys waren netzseitig noch nicht erlaubt, keine Dauerbeschränkung).
- **Rollback:** Nur Branch-Checkout → Rückweg simpel:
  `git checkout <alter-commit/main>` + Service-Restart.
- **Kein Cardano-Stack / AVX-512 nötig:** Der bestehende Server (Blockfrost als
  Node-RPC + Indexer, 1AM als Proof-Backend) reicht; ein selbst gehosteter
  Node/Cardano-db-sync ist für diesen Flow nicht erforderlich.
