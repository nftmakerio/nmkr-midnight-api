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
  resolveShieldedAddress,
  transferNight,
  queryNftContract,
  getUtxos,
  getTransaction,
  getTransactionHistory,
  registerDust,
  createCollection,
  mintNft,
} from './midnight-service.js';
import { NETWORKS } from './networks.js';

const app = express();
app.use(cors());
app.use(express.json());

// ---- Swagger ----

const networkEnum = { type: 'string', enum: ['preview', 'preprod', 'mainnet'], default: 'preview', description: 'Network (preview, preprod, mainnet)' };

const swaggerSpec: any = swaggerJsdoc({
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Midnight Network API',
      version: '1.1.0',
      description: `REST API for the Midnight Network.

Supported networks: **preview**, **preprod**, **mainnet**

Every endpoint accepts an optional \`network\` parameter. Default is \`preview\`.`,
    },
    servers: [
      { url: 'https://midnight-api.nmkr.io', description: 'Production' },
      { url: 'http://localhost:3000', description: 'Local' },
    ],
    tags: [
      { name: 'Wallet', description: 'Create, query wallets, register Dust' },
      { name: 'Transfer', description: 'NIGHT token transfers' },
      { name: 'NFT', description: 'NFT deploy, mint and query' },
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
  '/api/wallet/create': {
    post: {
      tags: ['Wallet'], summary: 'Create new wallet',
      description: 'Generates a new seed and derives all addresses.',
      requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { network: networkEnum } } } } },
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
        seed: { type: 'string', example: '5791029dcb19e89d09c369e13856ae279495dff7a183c982f34ba1fab510ecbc' },
        network: networkEnum,
      } } } } },
      responses: { 200: { description: 'Wallet info' }, 400: { description: 'Error' } },
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
        { in: 'query', name: 'network', schema: networkEnum },
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
        network: networkEnum,
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
        network: networkEnum,
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
        network: networkEnum,
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
        network: networkEnum,
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
        network: networkEnum,
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
        { in: 'query', name: 'network', schema: networkEnum },
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
  '/api/nft/create-collection': {
    post: {
      tags: ['NFT'], summary: 'Create new NFT collection',
      description: 'Deploys a new NFT contract. If no seed is provided, a new wallet is generated. Returns the ownerSeed — **keep this safe**, it is required for minting!',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['collection', 'symbol'], properties: {
        seed: { type: 'string', description: 'Optional: seed of the deployer. If empty, a new wallet is generated.' },
        collection: { type: 'string', description: 'Collection name', example: 'NMKRMidnightNFT' },
        symbol: { type: 'string', description: 'Collection symbol', example: 'NMKR' },
        network: networkEnum,
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
        network: networkEnum,
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
  '/api/nft/query/{contractAddress}': {
    get: {
      tags: ['NFT'], summary: 'Query NFT contract state',
      description: 'Reads collection info and all tokens with owner and URI.',
      parameters: [
        { in: 'path', name: 'contractAddress', required: true, schema: { type: 'string' }, example: '5d7824b0a708cc12669896513a18841fc2407e0314f125568e16931b8252797d' },
        { in: 'query', name: 'network', schema: networkEnum },
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

app.post('/api/wallet/create', async (req, res) => {
  try { res.json(await createNewWallet(req.body?.network)); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post('/api/wallet/info', (req, res) => {
  try {
    const { seed, network } = req.body;
    if (!seed) return res.status(400).json({ error: 'seed is required' });
    res.json(getWalletInfo(seed, network));
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
    const network = req.query.network as string | undefined;
    res.json(await getBalanceByAddress(req.params.address, network));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post('/api/wallet/balance', async (req, res) => {
  try {
    const { seed, network } = req.body;
    if (!seed) return res.status(400).json({ error: 'seed is required' });
    res.json(await getBalanceBySeed(seed, network));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post('/api/wallet/utxos', async (req, res) => {
  try {
    const { seed, network } = req.body;
    if (!seed) return res.status(400).json({ error: 'seed is required' });
    res.json(await getUtxos(seed, network));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post('/api/wallet/register-dust', async (req, res) => {
  try {
    const { seed, network } = req.body;
    if (!seed) return res.status(400).json({ error: 'seed is required' });
    res.json(await registerDust(seed, network));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post('/api/transfer/night', async (req, res) => {
  try {
    const { senderSeed, toAddress, amount, dustSeed, network } = req.body;
    if (!senderSeed || !toAddress || !amount) return res.status(400).json({ error: 'senderSeed, toAddress and amount are required' });
    res.json(await transferNight({ senderSeed, toAddress, amount, dustSeed, network }));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post('/api/wallet/transactions', async (req, res) => {
  try {
    const { seed, network } = req.body;
    if (!seed) return res.status(400).json({ error: 'seed is required' });
    res.json(await getTransactionHistory(seed, network));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get('/api/transaction/:txHash', async (req, res) => {
  try {
    const network = req.query.network as string | undefined;
    res.json(await getTransaction(req.params.txHash, network));
  } catch (err: any) {
    if (err.message === 'Transaction not found') return res.status(404).json({ error: 'Transaction not found' });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/nft/create-collection', async (req, res) => {
  try {
    const { seed, collection, symbol, network } = req.body;
    if (!collection || !symbol) return res.status(400).json({ error: 'collection and symbol are required' });
    res.json(await createCollection({ seed, collection, symbol, network }));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post('/api/nft/mint', async (req, res) => {
  try {
    const { ownerSeed, contractAddress, uri, toCoinPublicKey, toShieldedAddress, collection, symbol, network } = req.body;
    if (!ownerSeed || !uri) return res.status(400).json({ error: 'ownerSeed and uri are required' });
    res.json(await mintNft({ ownerSeed, contractAddress, uri, toCoinPublicKey, toShieldedAddress, collection, symbol, network }));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get('/api/nft/query/:contractAddress', async (req, res) => {
  try {
    const network = req.query.network as string | undefined;
    const result = await queryNftContract(req.params.contractAddress, network);
    res.json(result);
  } catch (err: any) {
    if (err.message === 'Contract not found') return res.status(404).json({ error: 'Contract not found' });
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', networks: Object.keys(NETWORKS), defaultNetwork: 'preview' });
});

// ---- Start ----

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('');
  console.log('=== Midnight API Server ===');
  console.log('');
  console.log(`  Swagger:  http://localhost:${PORT}/api-docs`);
  console.log(`  Health:   http://localhost:${PORT}/api/health`);
  console.log('');
  console.log(`  Networks: preview, preprod, mainnet`);
  console.log('');
});
