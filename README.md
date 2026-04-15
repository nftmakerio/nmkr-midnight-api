# NMKR Midnight API

REST API for the [Midnight Network](https://midnight.network/) — one instance per network (`preview`, `preprod`, `mainnet`).

Built with the Midnight SDK (wallet-sdk-facade 3.0, midnight-js 4.0, ledger-v8) and Express with Swagger UI.

## Features

- **Wallet Management** — Create wallets, recover from mnemonic, derive addresses, check balances, view UTXOs and transaction history
- **NIGHT Transfers** — Send NIGHT tokens to one or many recipients in a single transaction, optional separate dust provider
- **NFT Collections** — Deploy NFT smart contracts (Compact), mint, transfer, approve and burn NFTs
- **Soulbound Support** — Per-collection flag: standard NFT (`transferable: true`) or soulbound (`transferable: false`)
- **ERC-721-style Approvals** — Single-token (`approve`) and operator-wide (`approve-for-all`) approvals
- **Wallet Watching** — Persistent live monitoring of wallets via WebSocket — instant balance/UTXO/transaction queries
- **Address Watching** — Lightweight balance polling for unshielded addresses (no seed required)
- **Lace/1AM Compatible** — 128-char (full BIP39) seeds produce the same addresses as Lace and 1AM wallets
- **Swagger UI** — Interactive API documentation at `/api-docs`

## API Endpoints

### System

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/version` | Versions of API, Node, compactc, zkir, contract, Midnight Node, proof server, SDK packages |
| GET | `/api/health` | Health check + active network |

### Wallet

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/wallet/create` | Generate a new wallet (seed + mnemonic + addresses) |
| POST | `/api/wallet/info` | Derive addresses from a seed |
| POST | `/api/wallet/recover` | Recover a wallet from a 24-word BIP39 mnemonic |
| POST | `/api/wallet/resolve-shielded` | Extract CoinPublicKey from a `mn_shield-addr_...` (e.g. Lace) |
| GET | `/api/wallet/balance/:address` | NIGHT balance by address (no seed needed) |
| POST | `/api/wallet/balance` | Balance by seed (includes dust info) |
| POST | `/api/wallet/utxos` | List all unshielded UTXOs |
| POST | `/api/wallet/transactions` | Transaction history |
| POST | `/api/wallet/register-dust` | Register NIGHT UTXOs for dust generation |

### Watch (live monitoring)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/watch/add` | Start watching a wallet (`seed`, full sync) or address (`address`, lightweight polling) |
| POST | `/api/watch/remove` | Stop watching (by `seed` or `address`) |
| GET | `/api/watch/list` | List all watched wallets and addresses with current balances |

### Transfer

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/transfer/night` | Transfer NIGHT to one or multiple recipients in a single tx (raw amounts) |
| GET | `/api/transaction/:txHash` | Look up an unshielded transaction by hash |

### NFT

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/nft/create-collection` | Deploy a new NFT collection (with `transferable` flag) |
| POST | `/api/nft/mint` | Mint an NFT in an existing collection (or create one on the fly) |
| POST | `/api/nft/transfer` | Transfer a token (caller must be owner, approved spender, or operator) |
| POST | `/api/nft/approve` | Approve a single spender for ONE token |
| POST | `/api/nft/approve-for-all` | Approve / revoke an operator for ALL of caller's tokens |
| POST | `/api/nft/burn` | Destroy a token (only owner) |
| GET | `/api/nft/query/:contractAddress` | Read collection info + all tokens with owner, name and URI |

## Configuration

The API is configured via environment variables — one instance per network.

| Variable | Default | Purpose |
|----------|---------|---------|
| `MIDNIGHT_NETWORK` | `preprod` | Active network: `preview`, `preprod` or `mainnet` |
| `MIDNIGHT_API_URL` | `https://midnight-api.<network>.nmkr.io` | Public URL shown in Swagger |
| `MIDNIGHT_PROOF_SERVER` | `http://localhost:6300` | Local proof server endpoint |
| `PRIVATE_STATE_PASSWORD` | `Midnight-NFT-Local-Dev-2026!` | Encryption password for the local LevelDB private state store |
| `PORT` | `3000` | HTTP port the API binds to |

## Prerequisites

- **Node.js** v22+
- **Docker** (for the proof server)

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Start the proof server (Docker)

```bash
docker run -d --name midnight-proof-server -p 6300:6300 \
  midnightntwrk/proof-server:7.0.0 midnight-proof-server -v
```

One proof server handles all networks.

### 3. Start the API

The compiled NFT contract artifacts (TypeScript bindings, ZKIR, ZK keys) are committed in the repo, so no compilation step is needed for normal use.

```bash
MIDNIGHT_NETWORK=preprod npm run api
```

Open Swagger UI: **http://localhost:3000/api-docs**

### Optional: Recompile the contract

Only needed when you modify `contracts/nmkr-nft.compact`:

```bash
# Step 1: Compile (skips local ZK key generation)
compactc --skip-zk contracts/nmkr-nft.compact contracts/managed/nmkr-nft

# Step 2: Generate ZK keys via Docker (needed because zkir may not run on all CPUs)
docker run --rm -v $(pwd)/contracts/managed/nmkr-nft:/data \
  --platform linux/amd64 ubuntu:22.04 bash -c "
  apt-get update -qq && apt-get install -qq -y curl unzip >/dev/null 2>&1
  curl -sL https://github.com/midnightntwrk/compact/releases/download/compactc-v0.30.0/compactc_v0.30.0_x86_64-unknown-linux-musl.zip -o /tmp/c.zip
  unzip -o /tmp/c.zip -d /usr/local/bin/ >/dev/null && chmod +x /usr/local/bin/zkir
  mkdir -p /data/keys && zkir compile-many /data/zkir /data/keys
"
```

## Example Workflows

### Create a wallet, fund it, register dust

```bash
# Create a new wallet — save the seed and mnemonic somewhere safe!
curl -X POST http://localhost:3000/api/wallet/create

# Fund the unshielded address via the faucet:
# https://faucet.preprod.midnight.network/

# Register NIGHT UTXOs for dust generation (needed for transaction fees)
curl -X POST http://localhost:3000/api/wallet/register-dust \
  -H 'Content-Type: application/json' \
  -d '{"seed":"YOUR_SEED"}'
```

### Transfer NIGHT to multiple recipients in one transaction

Amounts are in **raw units** (1 NIGHT = 1,000,000 raw):

```bash
curl -X POST http://localhost:3000/api/transfer/night \
  -H 'Content-Type: application/json' \
  -d '{
    "senderSeed": "YOUR_SEED",
    "recipients": [
      { "toAddress": "mn_addr_preprod1...", "amount": "5000000" },
      { "toAddress": "mn_addr_preprod1...", "amount": "1500000" }
    ]
  }'
```

### Mint an NFT to a Lace/1AM wallet

```bash
# Step 1 (optional): Resolve shielded address → CoinPublicKey
# (the mint endpoint also accepts toShieldedAddress directly)
curl -X POST http://localhost:3000/api/wallet/resolve-shielded \
  -H 'Content-Type: application/json' \
  -d '{"shieldedAddress":"mn_shield-addr_preprod1..."}'

# Step 2: Mint — without contractAddress, a new collection is created
# The response includes contractAddress + ownerSeed for further mints.
curl -X POST http://localhost:3000/api/nft/mint \
  -H 'Content-Type: application/json' \
  -d '{
    "ownerSeed": "YOUR_SEED",
    "uri": "ipfs://your-metadata/1.json",
    "name": "My First NFT",
    "toShieldedAddress": "mn_shield-addr_preprod1...",
    "collection": "MyCollection",
    "symbol": "MC",
    "transferable": true
  }'
```

### Mint additional NFTs in the same collection

Use the `contractAddress` from the previous response:

```bash
curl -X POST http://localhost:3000/api/nft/mint \
  -H 'Content-Type: application/json' \
  -d '{
    "ownerSeed": "YOUR_SEED",
    "contractAddress": "5a98cf4e...",
    "uri": "ipfs://your-metadata/2.json",
    "name": "My Second NFT",
    "toShieldedAddress": "mn_shield-addr_preprod1..."
  }'
```

### Soulbound (non-transferable) collection

```bash
curl -X POST http://localhost:3000/api/nft/mint \
  -H 'Content-Type: application/json' \
  -d '{
    "ownerSeed": "YOUR_SEED",
    "uri": "ipfs://badge.json",
    "name": "Conference Badge 2026",
    "toShieldedAddress": "mn_shield-addr_preprod1...",
    "collection": "ConferenceBadges",
    "symbol": "BADGE",
    "transferable": false
  }'
```

Soulbound NFTs cannot be transferred or approved. Owners may still `burn` them.

### Approve a marketplace to sell a single NFT

```bash
curl -X POST http://localhost:3000/api/nft/approve \
  -H 'Content-Type: application/json' \
  -d '{
    "ownerSeed": "YOUR_SEED",
    "contractAddress": "5a98cf4e...",
    "tokenId": "0",
    "toShieldedAddress": "mn_shield-addr_preprod1MARKETPLACE..."
  }'
```

### Authorize an operator for ALL tokens

```bash
curl -X POST http://localhost:3000/api/nft/approve-for-all \
  -H 'Content-Type: application/json' \
  -d '{
    "ownerSeed": "YOUR_SEED",
    "contractAddress": "5a98cf4e...",
    "operatorShieldedAddress": "mn_shield-addr_preprod1OPERATOR...",
    "approved": true
  }'
```

### Transfer an NFT (owner, approved spender or operator)

```bash
curl -X POST http://localhost:3000/api/nft/transfer \
  -H 'Content-Type: application/json' \
  -d '{
    "ownerSeed": "CALLER_SEED",
    "contractAddress": "5a98cf4e...",
    "tokenId": "0",
    "toShieldedAddress": "mn_shield-addr_preprod1NEW_OWNER..."
  }'
```

### Burn an NFT

```bash
curl -X POST http://localhost:3000/api/nft/burn \
  -H 'Content-Type: application/json' \
  -d '{
    "ownerSeed": "YOUR_SEED",
    "contractAddress": "5a98cf4e...",
    "tokenId": "0"
  }'
```

### Live wallet monitoring

Watched wallets stay synced in the background, so balance/UTXO/transaction queries return instantly.

```bash
# Add wallet (full mode — needs seed for SDK sync)
curl -X POST http://localhost:3000/api/watch/add \
  -H 'Content-Type: application/json' \
  -d '{"seed":"YOUR_SEED","label":"Treasury"}'

# Or address-only (lightweight polling every 30s — no seed required)
curl -X POST http://localhost:3000/api/watch/add \
  -H 'Content-Type: application/json' \
  -d '{"address":"mn_addr_preprod1...","label":"Customer"}'

# List
curl http://localhost:3000/api/watch/list

# Remove
curl -X POST http://localhost:3000/api/watch/remove \
  -H 'Content-Type: application/json' \
  -d '{"seed":"YOUR_SEED"}'
```

## Address Types on Midnight

| Type | Format | Usage |
|------|--------|-------|
| Unshielded | `mn_addr_<network>1...` | NIGHT token transfers, dust, transaction fees |
| Shielded | `mn_shield-addr_<network>1...` | NFTs, privacy transactions, contract callers |
| CoinPublicKey | hex (32 bytes) | Internal — contained in shielded addresses |

The shielded address bundles a CoinPublicKey + EncryptionPublicKey. Use `/api/wallet/resolve-shielded` to extract the CoinPublicKey.

**Seed compatibility:** A seed can be either 64 hex chars (32 bytes) or 128 hex chars (64 bytes). The 128-char format (full BIP39 seed) produces the same addresses as Lace and 1AM wallets — use it when you want compatibility with those wallets.

## NFT Smart Contract

The NFT contract (`contracts/nmkr-nft.compact`) supports:

- **Mint** — only the contract owner can mint. NFTs are minted directly to a recipient's CoinPublicKey
- **Transfer** — owners can transfer; approved spenders and operators can also transfer
- **Approve** — single-token approval (cleared on transfer)
- **Approve-for-all** — operator approval for all tokens of a caller
- **Burn** — owners can destroy their tokens; works on soulbound collections too
- **Transferable flag** — set once at deploy time:
  - `true` (default) — standard NFT, owners can transfer/approve
  - `false` — soulbound, only mint and burn
- **On-chain metadata** — `name`, `uri` per token; `collectionName`, `collectionSymbol` per collection

**Note:** NFT owners are identified by their shielded `ZswapCoinPublicKey`. The unshielded address is only used for paying transaction fees.

## Tech Stack

- **Midnight SDK** — wallet-sdk-facade 3.0.0, midnight-js 4.0.4, ledger-v8 8.0.3, compact-js 2.5.0
- **Compact** — Smart contract language v0.22.0, compiler v0.30.0, runtime 0.15.0
- **Express** — REST API with Swagger UI, request logging with secret masking
- **Docker** — Proof server (midnightntwrk/proof-server:7.0.0)

## License

MIT
