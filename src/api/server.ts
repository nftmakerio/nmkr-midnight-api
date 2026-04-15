#!/usr/bin/env tsx
// =============================================================
// Midnight REST API with Swagger UI
// Supports: preview, preprod, mainnet
//
// Start: npx tsx src/api/server.ts
// Swagger: http://localhost:3000/api-docs
// =============================================================

import express from 'express';
import cors from 'cors';
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import {
  createNewWallet,
  getWalletInfo,
  getBalanceBySeed,
  getBalanceByAddress,
  recoverFromMnemonic,
  resolveShieldedAddress,
  getVersionInfo,
  transferNight,
  queryNftContract,
  getUtxos,
  getTransaction,
  getTransactionHistory,
  registerDust,
  createCollection,
  mintNft,
  transferNft,
} from './midnight-service.js';
import { ACTIVE_NETWORK, PUBLIC_API_URL } from './networks.js';
import { walletManager, addressWatcher } from './wallet-manager.js';

const app = express();
app.use(cors());
app.use(express.json());

// ---- Swagger ----

const swaggerSpec: any = swaggerJsdoc({
  definition: {
    openapi: '3.0.0',
    info: {
      title: `Midnight ${ACTIVE_NETWORK.networkId.toUpperCase()} API`,
      version: '1.2.0',
      description: `REST API for the Midnight Network.

**This instance runs on the \`${ACTIVE_NETWORK.networkId}\` network.**

For other networks, use the corresponding API instance.

**Seeds:** Use the full 128-char hex seed (from mnemonic recovery) for 1AM/Lace wallet compatibility. 64-char seeds also work but produce different addresses.`,
    },
    servers: [
      { url: PUBLIC_API_URL, description: `Production (${ACTIVE_NETWORK.networkId})` },
      { url: 'http://localhost:3000', description: 'Local' },
    ],
    tags: [
      { name: 'Wallet', description: 'Create, query wallets, register Dust' },
      { name: 'Transfer', description: 'NIGHT token transfers' },
      { name: 'NFT', description: 'NFT deploy, mint and query' },
      { name: 'Watch', description: 'Persistent wallet monitoring — watched wallets stay synced and respond instantly' },
      { name: 'System', description: 'API health and version info' },
    ],
  },
  apis: [],
});

swaggerSpec.components = {
  schemas: {
    Error: { type: 'object', properties: { error: { type: 'string' } } },
  },
};

swaggerSpec.paths = {
  '/api/version': {
    get: {
      tags: ['System'], summary: 'Get version info for all components',
      description: 'Returns versions of API, Node.js, Compact compiler, zkir, compiled contract, Midnight Node, Proof Server and SDK packages.',
      responses: { 200: { description: 'Version info' } },
    },
  },
  '/api/wallet/create': {
    post: {
      tags: ['Wallet'], summary: 'Create new wallet',
      description: 'Generates a new seed and derives all addresses.',
      responses: { 200: { description: 'Wallet created', content: { 'application/json': { schema: { type: 'object', properties: {
        seed: { type: 'string', description: 'Hex seed (SECRET!)' },
        mnemonic: { type: 'string', description: '24-word recovery phrase (SECRET!)' },
        coinPublicKey: { type: 'string' },
        shieldedAddress: { type: 'string' },
        unshieldedAddress: { type: 'string' },
        network: { type: 'string' },
      } } } } } },
    },
  },
  '/api/wallet/info': {
    post: {
      tags: ['Wallet'], summary: 'Wallet info from seed',
      description: 'Derives CoinPublicKey and addresses from a seed.',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['seed'], properties: {
        seed: { type: 'string', description: 'Hex seed (64 or 128 hex chars). Use 128 chars (full BIP39 seed) for 1AM/Lace compatibility.' },
      } } } } },
      responses: { 200: { description: 'Wallet info' }, 400: { description: 'Error' } },
    },
  },
  '/api/wallet/recover': {
    post: {
      tags: ['Wallet'], summary: 'Recover wallet from mnemonic',
      description: 'Derives the seed and all addresses from a 24-word BIP39 mnemonic phrase.',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['mnemonic'], properties: {
        mnemonic: { type: 'string', description: '24-word recovery phrase', example: 'hockey spring pottery noble guess purchase inform improve walnut expand drink body notable opinion dish abuse ketchup file win animal embody ethics donor march' },
      } } } } },
      responses: { 200: { description: 'Recovered wallet info' }, 400: { description: 'Invalid mnemonic' } },
    },
  },
  '/api/wallet/resolve-shielded': {
    post: {
      tags: ['Wallet'], summary: 'Extract CoinPublicKey from shielded address',
      description: 'Extracts the CoinPublicKey from a mn_shield-addr_... address (e.g. from Lace Wallet). The network is detected automatically from the address.',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['shieldedAddress'], properties: {
        shieldedAddress: { type: 'string', example: 'mn_shield-addr_preprod1jl7d4f6t6jd23a5vlenrkaugextfvm2s5w4lq8r2j9uzt24ccgvd403ttr3gyle60ah4gfdj30u0rp4c8pnpxkzmnv9rngvyddl8u6gxnnzv7' },
      } } } } },
      responses: { 200: { description: 'CoinPublicKey + EncryptionPublicKey' }, 400: { description: 'Invalid address' } },
    },
  },
  '/api/wallet/balance/{address}': {
    get: {
      tags: ['Wallet'], summary: 'Balance by address (no seed required)',
      description: 'Queries the unshielded NIGHT balance. The network is detected from the address (mn_addr_preview1... / mn_addr_preprod1... / mn_addr1...).',
      parameters: [
        { in: 'path', name: 'address', required: true, schema: { type: 'string' }, example: 'mn_addr_preview1c0g6vynydk8p6clmd548lhgw6pchd0hsuzqdyvj5zrptguul22mspy9xw6' },
      ],
      responses: { 200: { description: 'Balance' }, 500: { description: 'Error' } },
    },
  },
  '/api/wallet/balance': {
    post: {
      tags: ['Wallet'], summary: 'Balance by seed (incl. Dust)',
      description: 'Synchronizes the wallet and returns NIGHT + Dust balance. Takes 10-30s.',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['seed'], properties: {
        seed: { type: 'string' },
      } } } } },
      responses: { 200: { description: 'Balance with Dust info' }, 500: { description: 'Error' } },
    },
  },
  '/api/wallet/utxos': {
    post: {
      tags: ['Wallet'], summary: 'Query UTXOs of a wallet',
      description: 'Returns all unshielded UTXOs of a wallet with value, token type, dust registration and transaction details. Requires the seed (wallet sync needed).',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['seed'], properties: {
        seed: { type: 'string', example: '78053916a197eca740f9537da779ff7a89e213e6cc2f493ca2697161fe6baa3f' },
      } } } } },
      responses: {
        200: { description: 'UTXO list', content: { 'application/json': { schema: { type: 'object', properties: {
          address: { type: 'string' },
          network: { type: 'string' },
          totalNight: { type: 'number' },
          totalRaw: { type: 'string' },
          utxoCount: { type: 'integer' },
          utxos: { type: 'array', items: { type: 'object', properties: {
            index: { type: 'integer' },
            value: { type: 'string', description: 'Raw value' },
            night: { type: 'number', description: 'NIGHT amount' },
            tokenType: { type: 'string' },
            intentHash: { type: 'string', description: 'Hash of the creating transaction' },
            outputNo: { type: 'integer' },
            ctime: { type: 'integer', description: 'Creation timestamp' },
            registeredForDustGeneration: { type: 'boolean' },
          } } },
        } } } } },
        500: { description: 'Error' },
      },
    },
  },
  '/api/wallet/register-dust': {
    post: {
      tags: ['Wallet'], summary: 'Register NIGHT UTXOs for Dust',
      description: 'Registers NIGHT UTXOs for automatic DUST generation. DUST is required for transaction fees.',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['seed'], properties: {
        seed: { type: 'string' },
      } } } } },
      responses: { 200: { description: 'Registration' }, 500: { description: 'Error' } },
    },
  },
  '/api/transfer/night': {
    post: {
      tags: ['Transfer'], summary: 'Transfer NIGHT tokens',
      description: 'Sends NIGHT from a wallet to an unshielded address. Optional separate Dust provider.',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['senderSeed', 'toAddress', 'amount'], properties: {
        senderSeed: { type: 'string', description: 'Seed of the sender' },
        toAddress: { type: 'string', description: 'Recipient mn_addr_...', example: 'mn_addr_preprod1fx3m83tputlrjrl7j94h4mxmxpevg0542d98w4ssq4canfqrvt7swmc7a9' },
        amount: { type: 'number', description: 'Amount in NIGHT', example: 5 },
        dustSeed: { type: 'string', description: 'Optional: seed of the Dust provider' },
      } } } } },
      responses: { 200: { description: 'Transfer successful' }, 500: { description: 'Error' } },
    },
  },
  '/api/wallet/transactions': {
    post: {
      tags: ['Wallet'], summary: 'Transaction history of a wallet',
      description: 'Returns all unshielded transactions of a wallet with sender, recipient, amounts and whether it was a receive or send. Requires the seed (wallet sync). Can take 15-30s.',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['seed'], properties: {
        seed: { type: 'string', example: '78053916a197eca740f9537da779ff7a89e213e6cc2f493ca2697161fe6baa3f' },
      } } } } },
      responses: {
        200: { description: 'Transaction list', content: { 'application/json': { schema: { type: 'object', properties: {
          address: { type: 'string' },
          network: { type: 'string' },
          transactionCount: { type: 'integer' },
          transactions: { type: 'array', items: { type: 'object', properties: {
            txHash: { type: 'string' },
            type: { type: 'string', enum: ['sent', 'received', 'self', 'unknown'], description: 'sent=outgoing, received=incoming, self=internal' },
            netAmount: { type: 'number', description: 'Net amount in NIGHT (positive=received, negative=sent)' },
            netFormatted: { type: 'string', example: '+5.000000 NIGHT' },
            blockHeight: { type: 'integer' },
            timestamp: { type: 'string' },
            inputs: { type: 'array', items: { type: 'object', properties: { from: { type: 'string' }, night: { type: 'number' } } } },
            outputs: { type: 'array', items: { type: 'object', properties: { to: { type: 'string' }, night: { type: 'number' } } } },
          } } },
        } } } } },
        500: { description: 'Error' },
      },
    },
  },
  '/api/transaction/{txHash}': {
    get: {
      tags: ['Transfer'], summary: 'Look up a transaction',
      description: 'Shows the details of an unshielded transaction: inputs (FROM), outputs (TO), amounts and block info. The txHash can be obtained e.g. from the intentHash of UTXOs or as the return value of a transfer.',
      parameters: [
        { in: 'path', name: 'txHash', required: true, schema: { type: 'string' }, description: 'Transaction hash (hex)', example: '0adf6a6556b08088fb040d19869474f9cba2c5b232e5f943e36c4678ceaef9aa' },
      ],
      responses: {
        200: { description: 'Transaction details', content: { 'application/json': { schema: { type: 'object', properties: {
          txHash: { type: 'string' },
          blockHeight: { type: 'integer' },
          timestamp: { type: 'string' },
          inputs: { type: 'array', items: { type: 'object', properties: {
            from: { type: 'string', description: 'Sender mn_addr_...' },
            value: { type: 'string' },
            night: { type: 'number' },
            tokenType: { type: 'string' },
          } } },
          outputs: { type: 'array', items: { type: 'object', properties: {
            to: { type: 'string', description: 'Recipient mn_addr_...' },
            value: { type: 'string' },
            night: { type: 'number' },
            tokenType: { type: 'string' },
            outputIndex: { type: 'integer' },
          } } },
          contractActions: { type: 'array', items: { type: 'string' }, description: 'Contract addresses if a smart contract is involved' },
          network: { type: 'string' },
        } } } } },
        404: { description: 'Transaction not found' },
      },
    },
  },
  '/api/watch/add': {
    post: {
      tags: ['Watch'], summary: 'Add wallet/address to watch list',
      description: 'Two modes:\n\n**With address only (lightweight):** Polls balance every 30s via CLI. No seed required. Returns balance + UTXO count.\n\n**With seed (full):** Persistent WebSocket sync. Returns balance, UTXOs, dust, transactions instantly.',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: {
        address: { type: 'string', description: 'Unshielded address (mn_addr_...) — lightweight mode, no seed needed', example: 'mn_addr_preview1c0g6vynydk8p6clmd548lhgw6pchd0hsuzqdyvj5zrptguul22mspy9xw6' },
        seed: { type: 'string', description: 'Wallet seed — full mode with WebSocket sync' },
        label: { type: 'string', description: 'Optional label', example: 'Treasury Wallet' },
      } } } } },
      responses: { 200: { description: 'Wallet/address added' }, 400: { description: 'Either address or seed is required' }, 500: { description: 'Error' } },
    },
  },
  '/api/watch/remove': {
    post: {
      tags: ['Watch'], summary: 'Remove wallet/address from watch list',
      description: 'Stops monitoring. Provide the same field (address or seed) used when adding.',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: {
        address: { type: 'string' },
        seed: { type: 'string' },
      } } } } },
      responses: { 200: { description: 'Removed' }, 404: { description: 'Not found in watch list' } },
    },
  },
  '/api/watch/list': {
    get: {
      tags: ['Watch'], summary: 'List all watched wallets and addresses',
      description: 'Returns all watched items with current balances and sync status.',
      responses: { 200: { description: 'Watched list' } },
    },
  },
  '/api/nft/create-collection': {
    post: {
      tags: ['NFT'], summary: 'Create new NFT collection',
      description: 'Deploys a new NFT contract. If no seed is provided, a new wallet is generated. Returns the ownerSeed — **keep this safe**, it is required for minting!',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['collection', 'symbol'], properties: {
        seed: { type: 'string', description: 'Optional: seed of the deployer. If empty, a new wallet is generated.' },
        collection: { type: 'string', description: 'Collection name', example: 'NMKRMidnightNFT' },
        symbol: { type: 'string', description: 'Collection symbol', example: 'NMKR' },
      } } } } },
      responses: {
        200: { description: 'Collection created', content: { 'application/json': { schema: { type: 'object', properties: {
          contractAddress: { type: 'string', description: 'Address of the NFT contract' },
          ownerSeed: { type: 'string', description: 'Seed of the owner — keep SECRET! Required for minting.' },
          ownerCoinPublicKey: { type: 'string' },
          unshieldedAddress: { type: 'string', description: 'Send NIGHT here for fees' },
          collection: { type: 'string' },
          symbol: { type: 'string' },
          network: { type: 'string' },
        } } } } },
        500: { description: 'Error' },
      },
    },
  },
  '/api/nft/mint': {
    post: {
      tags: ['NFT'], summary: 'Mint NFT in existing collection',
      description: 'Mints a new NFT in an existing collection. Requires the ownerSeed (from create-collection). If contractAddress is missing, a new collection is created automatically.',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['ownerSeed', 'uri'], properties: {
        ownerSeed: { type: 'string', description: 'Seed of the collection owner (from create-collection)' },
        contractAddress: { type: 'string', description: 'Contract address of the collection. If empty, a new collection is created.' },
        uri: { type: 'string', description: 'Metadata URI (JSON)', example: 'ipfs://example/token-1.json' },
        toCoinPublicKey: { type: 'string', description: 'Optional: recipient CoinPublicKey (hex)' },
        toShieldedAddress: { type: 'string', description: 'Optional: shielded address (mn_shield-addr_...) — resolved automatically' },
        collection: { type: 'string', description: 'Only for new collection: name', example: 'MidnightNFT' },
        symbol: { type: 'string', description: 'Only for new collection: symbol', example: 'MNFT' },
      } } } } },
      responses: {
        200: { description: 'NFT minted', content: { 'application/json': { schema: { type: 'object', properties: {
          contractAddress: { type: 'string' },
          tokenId: { type: 'string' },
          owner: { type: 'string' },
          uri: { type: 'string' },
          network: { type: 'string' },
          newCollection: { type: 'boolean', description: 'true if a new collection was created' },
        } } } } },
        500: { description: 'Error' },
      },
    },
  },
  '/api/nft/transfer': {
    post: {
      tags: ['NFT'], summary: 'Transfer an NFT to another address',
      description: 'Transfers an existing NFT to a new owner. Requires the ownerSeed of the current NFT holder, the contractAddress of the collection, and the tokenId of the specific NFT.',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['ownerSeed', 'contractAddress', 'tokenId'], properties: {
        ownerSeed: { type: 'string', description: 'Seed of the current NFT owner' },
        contractAddress: { type: 'string', description: 'Contract address of the NFT collection' },
        tokenId: { type: 'string', description: 'Token ID to transfer (e.g. "0", "1")', example: '0' },
        toCoinPublicKey: { type: 'string', description: 'Recipient CoinPublicKey (hex)' },
        toShieldedAddress: { type: 'string', description: 'Recipient shielded address (mn_shield-addr_...) — resolved automatically' },
      } } } } },
      responses: {
        200: { description: 'NFT transferred', content: { 'application/json': { schema: { type: 'object', properties: {
          contractAddress: { type: 'string' },
          tokenId: { type: 'string' },
          from: { type: 'string', description: 'CoinPublicKey of previous owner' },
          to: { type: 'string', description: 'CoinPublicKey of new owner' },
          network: { type: 'string' },
        } } } } },
        500: { description: 'Error' },
      },
    },
  },
  '/api/nft/query/{contractAddress}': {
    get: {
      tags: ['NFT'], summary: 'Query NFT contract state',
      description: 'Reads collection info and all tokens with owner and URI.',
      parameters: [
        { in: 'path', name: 'contractAddress', required: true, schema: { type: 'string' }, example: '5d7824b0a708cc12669896513a18841fc2407e0314f125568e16931b8252797d' },
      ],
      responses: { 200: { description: 'Contract state' }, 404: { description: 'Not found' } },
    },
  },
};

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: 'Midnight API',
}));
app.get('/api-docs.json', (_req, res) => res.json(swaggerSpec));

// ---- Routes ----

app.post('/api/wallet/create', async (_req, res) => {
  try { res.json(await createNewWallet()); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post('/api/wallet/info', (req, res) => {
  try {
    const { seed } = req.body;
    if (!seed) return res.status(400).json({ error: 'seed is required' });
    res.json(getWalletInfo(seed));
  } catch (err: any) { res.status(400).json({ error: err.message }); }
});

app.post('/api/wallet/recover', (req, res) => {
  try {
    const { mnemonic } = req.body;
    if (!mnemonic) return res.status(400).json({ error: 'mnemonic is required' });
    res.json(recoverFromMnemonic(mnemonic));
  } catch (err: any) { res.status(400).json({ error: err.message }); }
});

app.post('/api/wallet/resolve-shielded', (req, res) => {
  try {
    const { shieldedAddress } = req.body;
    if (!shieldedAddress) return res.status(400).json({ error: 'shieldedAddress is required' });
    res.json(resolveShieldedAddress(shieldedAddress));
  } catch (err: any) { res.status(400).json({ error: err.message }); }
});

app.get('/api/wallet/balance/:address', async (req, res) => {
  try {
    res.json(await getBalanceByAddress(req.params.address));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post('/api/wallet/balance', async (req, res) => {
  try {
    const { seed } = req.body;
    if (!seed) return res.status(400).json({ error: 'seed is required' });
    res.json(await getBalanceBySeed(seed));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post('/api/wallet/utxos', async (req, res) => {
  try {
    const { seed } = req.body;
    if (!seed) return res.status(400).json({ error: 'seed is required' });
    res.json(await getUtxos(seed));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post('/api/wallet/register-dust', async (req, res) => {
  try {
    const { seed } = req.body;
    if (!seed) return res.status(400).json({ error: 'seed is required' });
    res.json(await registerDust(seed));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post('/api/transfer/night', async (req, res) => {
  try {
    const { senderSeed, toAddress, amount, dustSeed } = req.body;
    if (!senderSeed || !toAddress || !amount) return res.status(400).json({ error: 'senderSeed, toAddress and amount are required' });
    res.json(await transferNight({ senderSeed, toAddress, amount, dustSeed }));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post('/api/wallet/transactions', async (req, res) => {
  try {
    const { seed } = req.body;
    if (!seed) return res.status(400).json({ error: 'seed is required' });
    res.json(await getTransactionHistory(seed));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get('/api/transaction/:txHash', async (req, res) => {
  try {
    res.json(await getTransaction(req.params.txHash));
  } catch (err: any) {
    if (err.message === 'Transaction not found') return res.status(404).json({ error: 'Transaction not found' });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/nft/create-collection', async (req, res) => {
  try {
    const { seed, collection, symbol } = req.body;
    if (!collection || !symbol) return res.status(400).json({ error: 'collection and symbol are required' });
    res.json(await createCollection({ seed, collection, symbol }));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post('/api/nft/mint', async (req, res) => {
  try {
    const { ownerSeed, contractAddress, uri, toCoinPublicKey, toShieldedAddress, collection, symbol } = req.body;
    if (!ownerSeed || !uri) return res.status(400).json({ error: 'ownerSeed and uri are required' });
    res.json(await mintNft({ ownerSeed, contractAddress, uri, toCoinPublicKey, toShieldedAddress, collection, symbol }));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ---- Watch Routes ----

app.post('/api/watch/add', async (req, res) => {
  try {
    const { seed, address, label } = req.body;

    if (seed) {
      const managed = await walletManager.add(seed, label);
      res.json({
        mode: 'full',
        status: 'watching',
        synced: managed.synced,
        label: managed.info.label,
        ...managed.addresses,
      });
    } else if (address) {
      const entry = addressWatcher.add(address, label);
      res.json({
        mode: 'lightweight',
        status: 'watching',
        address: entry.address,
        label: entry.label,
        pollInterval: '30s',
        lastBalance: entry.lastBalance,
        lastChecked: entry.lastChecked,
      });
    } else {
      return res.status(400).json({ error: 'Either address or seed is required' });
    }
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post('/api/watch/remove', async (req, res) => {
  try {
    const { seed, address } = req.body;
    if (seed) {
      const removed = await walletManager.remove(seed);
      if (!removed) return res.status(404).json({ error: 'Wallet not found in watch list' });
      res.json({ status: 'removed', mode: 'full' });
    } else if (address) {
      const removed = addressWatcher.remove(address);
      if (!removed) return res.status(404).json({ error: 'Address not found in watch list' });
      res.json({ status: 'removed', mode: 'lightweight' });
    } else {
      return res.status(400).json({ error: 'Either address or seed is required' });
    }
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get('/api/watch/list', (_req, res) => {
  res.json({
    fullWallets: walletManager.list(),
    addressWatches: addressWatcher.list(),
  });
});

app.post('/api/nft/transfer', async (req, res) => {
  try {
    const { ownerSeed, contractAddress, tokenId, toCoinPublicKey, toShieldedAddress } = req.body;
    if (!ownerSeed || !contractAddress || tokenId === undefined) return res.status(400).json({ error: 'ownerSeed, contractAddress and tokenId are required' });
    if (!toCoinPublicKey && !toShieldedAddress) return res.status(400).json({ error: 'Either toCoinPublicKey or toShieldedAddress is required' });
    res.json(await transferNft({ ownerSeed, contractAddress, tokenId: String(tokenId), toCoinPublicKey, toShieldedAddress }));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get('/api/nft/query/:contractAddress', async (req, res) => {
  try {
    const result = await queryNftContract(req.params.contractAddress);
    res.json(result);
  } catch (err: any) {
    if (err.message === 'Contract not found') return res.status(404).json({ error: 'Contract not found' });
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/version', async (_req, res) => {
  try {
    res.json(await getVersionInfo());
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', network: ACTIVE_NETWORK.networkId });
});

// ---- Start ----

const PORT = process.env.PORT || 3000;

// Initialize wallet manager (reconnect watched wallets), then start server
addressWatcher.initialize();
walletManager.initialize().then(() => {
  app.listen(PORT, () => {
    console.log('');
    console.log('=== Midnight API Server ===');
    console.log('');
    console.log(`  Swagger:  http://localhost:${PORT}/api-docs`);
    console.log(`  Health:   http://localhost:${PORT}/api/health`);
    console.log('');
    console.log(`  Network:  ${ACTIVE_NETWORK.networkId}`);
    console.log(`  Public:   ${PUBLIC_API_URL}`);
    console.log(`  Watched:  ${walletManager.list().length} wallet(s)`);
    console.log('');
  });
}).catch((err) => {
  console.error('Failed to initialize wallet manager:', err.message);
  // Start server anyway — watch feature just won't have persisted wallets
  app.listen(PORT, () => {
    console.log(`  Swagger: http://localhost:${PORT}/api-docs`);
  });
});
