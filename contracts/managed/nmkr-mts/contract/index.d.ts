import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type ZswapCoinPublicKey = { bytes: Uint8Array };

export type ContractAddress = { bytes: Uint8Array };

export type Witnesses<PS> = {
}

export type ImpureCircuits<PS> = {
  name(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, string>;
  totalSupply(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, bigint>;
  mint(context: __compactRuntime.CircuitContext<PS>,
       tokenId_0: Uint8Array,
       recipient_0: ZswapCoinPublicKey,
       nonce_0: Uint8Array,
       nftName_0: Uint8Array,
       symbol_0: Uint8Array,
       description_0: Uint8Array,
       image_0: Uint8Array,
       mediaType_0: Uint8Array): __compactRuntime.CircuitResults<PS, Uint8Array>;
}

export type ProvableCircuits<PS> = {
  name(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, string>;
  totalSupply(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, bigint>;
  mint(context: __compactRuntime.CircuitContext<PS>,
       tokenId_0: Uint8Array,
       recipient_0: ZswapCoinPublicKey,
       nonce_0: Uint8Array,
       nftName_0: Uint8Array,
       symbol_0: Uint8Array,
       description_0: Uint8Array,
       image_0: Uint8Array,
       mediaType_0: Uint8Array): __compactRuntime.CircuitResults<PS, Uint8Array>;
}

export type PureCircuits = {
}

export type Circuits<PS> = {
  name(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, string>;
  totalSupply(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, bigint>;
  mint(context: __compactRuntime.CircuitContext<PS>,
       tokenId_0: Uint8Array,
       recipient_0: ZswapCoinPublicKey,
       nonce_0: Uint8Array,
       nftName_0: Uint8Array,
       symbol_0: Uint8Array,
       description_0: Uint8Array,
       image_0: Uint8Array,
       mediaType_0: Uint8Array): __compactRuntime.CircuitResults<PS, Uint8Array>;
}

export type Ledger = {
  readonly collectionName: string;
  metadata: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): { name: Uint8Array,
                                 f1: boolean,
                                 symbol: Uint8Array,
                                 f2: boolean,
                                 f3: boolean,
                                 f4: boolean,
                                 description: Uint8Array,
                                 f5: boolean,
                                 image: Uint8Array,
                                 f6: boolean,
                                 mediaType: Uint8Array,
                                 f7: bigint
                               };
    [Symbol.iterator](): Iterator<[Uint8Array, { name: Uint8Array,
  f1: boolean,
  symbol: Uint8Array,
  f2: boolean,
  f3: boolean,
  f4: boolean,
  description: Uint8Array,
  f5: boolean,
  image: Uint8Array,
  f6: boolean,
  mediaType: Uint8Array,
  f7: bigint
}]>
  };
  supply: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): bigint;
    [Symbol.iterator](): Iterator<[Uint8Array, bigint]>
  };
  readonly contractOwner: ZswapCoinPublicKey;
  readonly mintedCount: bigint;
}

export type ContractReferenceLocations = any;

export declare const contractReferenceLocations : ContractReferenceLocations;

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  provableCircuits: ProvableCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>,
               _name_1: string,
               _owner_0: ZswapCoinPublicKey): __compactRuntime.ConstructorResult<PS>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
