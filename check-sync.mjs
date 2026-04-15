import { WebSocket } from 'ws';
globalThis.WebSocket = WebSocket;
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import { createKeystore, InMemoryTransactionHistoryStorage, PublicKey, UnshieldedWallet } from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import * as Rx from 'rxjs';

setNetworkId('preprod');
const seed = '78053916a197eca740f9537da779ff7a89e213e6cc2f493ca2697161fe6baa3f769e44b8edc817bcdc04cd52451b20a1175b28b2bd62e605d4ba89b4b0105a2f';
const hdw = HDWallet.fromSeed(Buffer.from(seed, 'hex'));
const dr = hdw.hdWallet.selectAccount(0).selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust]).deriveKeysAt(0);
const keys = dr.keys; hdw.hdWallet.clear();
const sk = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
const dk = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
const ks = createKeystore(keys[Roles.NightExternal], 'preprod');

const cfg = {
  networkId: 'preprod',
  indexerClientConnection: { indexerHttpUrl: 'https://indexer.preprod.midnight.network/api/v4/graphql', indexerWsUrl: 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws' },
  provingServerUrl: new URL('http://localhost:6300'),
  relayURL: new URL('wss://rpc.preprod.midnight.network'),
};
const facade = await WalletFacade.init({
  configuration: cfg,
  shielded: c => ShieldedWallet({...c}).startWithSecretKeys(sk),
  unshielded: c => UnshieldedWallet({...c, txHistoryStorage: new InMemoryTransactionHistoryStorage()}).startWithPublicKey(PublicKey.fromKeyStore(ks)),
  dust: c => DustWallet({...c, costParameters: {additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5}}).startWithSeed(keys[Roles.Dust], ledger.LedgerParameters.initialParameters().dust),
});
await facade.start(sk, dk);

let i = 0;
facade.state().pipe(Rx.throttleTime(2000)).subscribe(s => {
  i++;
  console.log(`[${i}] isSynced=${s.isSynced} shielded.progress=${s.shielded?.progress ? Object.keys(s.shielded.progress).join(",") : "none"} unshielded.coins=${s.unshielded?.availableCoins?.length} dust.coins=${s.dust?.availableCoins?.length}`);
  if (i > 10 || s.isSynced) process.exit(0);
});
setTimeout(() => process.exit(0), 60000);
