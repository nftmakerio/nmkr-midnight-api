# NMKR Midnight API

REST API for the [Midnight Network](https://midnight.network/) — supporting **preview**, **preprod**, and **mainnet**.

Built with the Midnight SDK (wallet-sdk-facade, midnight-js, compact-js) and Express with Swagger UI.

## Features

- **Wallet Management** — Create wallets, derive addresses, check balances, view UTXOs
- **NIGHT Transfers** — Send NIGHT tokens between unshielded addresses with optional separate dust provider
- **NFT Collections** — Deploy NFT smart contracts (Compact language) and mint NFTs to any shielded address
- **Transaction History** — Look up transactions and UTXO details
- **Multi-Network** — All endpoints support preview, preprod, and mainnet via a `network` parameter
- **Swagger UI** — Interactive API documentation at `/api-docs`

## API Endpoints

### Wallet

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/wallet/create` | Generate a new wallet (seed + all addresses) |
| POST | `/api/wallet/info` | Derive addresses from a seed |
| POST | `/api/wallet/resolve-shielded` | Extract CoinPublicKey from a shielded address (e.g. Lace Wallet) |
| GET | `/api/wallet/balance/:address` | Check NIGHT balance by address (no seed needed) |
| POST | `/api/wallet/balance` | Check balance by seed (includes dust info) |
| POST | `/api/wallet/utxos` | List all unshielded UTXOs |
| POST | `/api/wallet/transactions` | Transaction history |
| POST | `/api/wallet/register-dust` | Register NIGHT UTXOs for dust generation |

### Transfer

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/transfer/night` | Transfer NIGHT tokens |
| GET | `/api/transaction/:txHash` | Look up a transaction by hash |

### NFT

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/nft/create-collection` | Deploy a new NFT collection contract |
| POST | `/api/nft/mint` | Mint an NFT (existing or new collection) |
| GET | `/api/nft/query/:contractAddress` | Query NFT collection and token details |

## Prerequisites

- **Node.js** v22+
- **Docker** (for the proof server)
- **Compact Compiler** v0.29.0 (only needed to recompile the contract)

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

One proof server handles all networks (preview, preprod, mainnet).

### 3. Compile the NFT contract

The compiled contract artifacts are not included in the repo. You need to compile once:

```bash
# Compile the Compact contract (skip local ZK key generation)
compact --skip-zk contracts/nmkr-nft.compact contracts/managed/nmkr-nft

# Generate ZK keys via Docker (needed because zkir may not run on all CPUs)
docker run --rm -v $(pwd)/contracts/managed/nmkr-nft:/data \
  --platform linux/amd64 ubuntu:22.04 bash -c "
  apt-get update -qq && apt-get install -qq -y curl unzip >/dev/null 2>&1
  curl -sL https://github.com/midnightntwrk/compact/releases/download/compactc-v0.29.0/compactc_v0.29.0_x86_64-unknown-linux-musl.zip -o /tmp/compact.zip
  unzip -o /tmp/compact.zip -d /usr/local/bin/ >/dev/null
  chmod +x /usr/local/bin/*
  cd /data && zkir compile-many zkir keys
"
```

### 4. Start the API

```bash
npm run api
```

Open Swagger UI: **http://localhost:3000/api-docs**

## Example Workflow

### Create a wallet and fund it

```bash
# Create a new wallet
curl -X POST http://localhost:3000/api/wallet/create \
  -H 'Content-Type: application/json' \
  -d '{"network": "preview"}'

# Fund the unshielded address via faucet:
# https://faucet.preview.midnight.network/

# Register for dust generation (needed for transaction fees)
curl -X POST http://localhost:3000/api/wallet/register-dust \
  -H 'Content-Type: application/json' \
  -d '{"seed": "YOUR_SEED", "network": "preview"}'
```

### Mint an NFT to a Lace Wallet

```bash
# Step 1: Resolve the Lace shielded address to get CoinPublicKey
curl -X POST http://localhost:3000/api/wallet/resolve-shielded \
  -H 'Content-Type: application/json' \
  -d '{"shieldedAddress": "mn_shield-addr_preview1..."}'

# Step 2: Create a collection and mint
curl -X POST http://localhost:3000/api/nft/mint \
  -H 'Content-Type: application/json' \
  -d '{
    "ownerSeed": "YOUR_SEED",
    "uri": "ipfs://your-metadata/1.json",
    "toShieldedAddress": "mn_shield-addr_preview1...",
    "collection": "MyCollection",
    "symbol": "MC",
    "network": "preview"
  }'
```

### Transfer NIGHT tokens

```bash
curl -X POST http://localhost:3000/api/transfer/night \
  -H 'Content-Type: application/json' \
  -d '{
    "senderSeed": "YOUR_SEED",
    "toAddress": "mn_addr_preview1...",
    "amount": 10,
    "network": "preview"
  }'
```

## Address Types on Midnight

| Type | Format | Usage |
|------|--------|-------|
| Unshielded | `mn_addr_preview1...` | NIGHT token transfers |
| Shielded | `mn_shield-addr_preview1...` | NFTs, privacy transactions |
| CoinPublicKey | `77ee89b2...` (hex) | Internal contract identity |

The shielded address contains both the CoinPublicKey and EncryptionPublicKey. Use `/api/wallet/resolve-shielded` to extract the CoinPublicKey from a shielded address.

## NFT Smart Contract

The NFT contract (`contracts/nmkr-nft.compact`) implements:

- **create-collection**: Deploy with collection name, symbol, and owner
- **mint**: Only the contract owner can mint. NFTs can be minted directly to any CoinPublicKey
- **transfer**: Token holders can transfer their NFTs
- **query**: Read collection info, token ownership, and metadata URIs

## Tech Stack

- **Midnight SDK** — wallet-sdk-facade 2.0.0, midnight-js 3.2.0, ledger-v7 7.0.3
- **Compact** — Smart contract language v0.21.0, compiler v0.29.0
- **Express** — REST API with Swagger UI
- **Docker** — Proof server (midnightntwrk/proof-server:7.0.0)

## License

MIT
