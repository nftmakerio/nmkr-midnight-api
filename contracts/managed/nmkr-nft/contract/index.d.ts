import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type ZswapCoinPublicKey = { bytes: Uint8Array };

export type ContractAddress = { bytes: Uint8Array };

export type Witnesses<PS> = {
}

export type ImpureCircuits<PS> = {
  name(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, string>;
  symbol(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, string>;
  ownerOf(context: __compactRuntime.CircuitContext<PS>, tokenId_0: bigint): __compactRuntime.CircuitResults<PS, ZswapCoinPublicKey>;
  tokenURI(context: __compactRuntime.CircuitContext<PS>, tokenId_0: bigint): __compactRuntime.CircuitResults<PS, string>;
  tokenName(context: __compactRuntime.CircuitContext<PS>, tokenId_0: bigint): __compactRuntime.CircuitResults<PS, string>;
  tokenImage(context: __compactRuntime.CircuitContext<PS>, tokenId_0: bigint): __compactRuntime.CircuitResults<PS, string>;
  tokenMediaType(context: __compactRuntime.CircuitContext<PS>, tokenId_0: bigint): __compactRuntime.CircuitResults<PS, string>;
  totalSupply(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, bigint>;
  getApproved(context: __compactRuntime.CircuitContext<PS>, tokenId_0: bigint): __compactRuntime.CircuitResults<PS, ZswapCoinPublicKey>;
  mint(context: __compactRuntime.CircuitContext<PS>,
       to_0: ZswapCoinPublicKey,
       uri_0: string,
       tokenName_0: string,
       image_0: string,
       mediaType_0: string): __compactRuntime.CircuitResults<PS, bigint>;
  transfer(context: __compactRuntime.CircuitContext<PS>,
           to_0: ZswapCoinPublicKey,
           tokenId_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  approve(context: __compactRuntime.CircuitContext<PS>,
          to_0: ZswapCoinPublicKey,
          tokenId_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  setApprovalForAll(context: __compactRuntime.CircuitContext<PS>,
                    operator_0: ZswapCoinPublicKey,
                    approved_0: boolean): __compactRuntime.CircuitResults<PS, []>;
  isApprovedForAll(context: __compactRuntime.CircuitContext<PS>,
                   owner_0: ZswapCoinPublicKey,
                   operator_0: ZswapCoinPublicKey): __compactRuntime.CircuitResults<PS, boolean>;
  burn(context: __compactRuntime.CircuitContext<PS>, tokenId_0: bigint): __compactRuntime.CircuitResults<PS, []>;
}

export type ProvableCircuits<PS> = {
  name(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, string>;
  symbol(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, string>;
  ownerOf(context: __compactRuntime.CircuitContext<PS>, tokenId_0: bigint): __compactRuntime.CircuitResults<PS, ZswapCoinPublicKey>;
  tokenURI(context: __compactRuntime.CircuitContext<PS>, tokenId_0: bigint): __compactRuntime.CircuitResults<PS, string>;
  tokenName(context: __compactRuntime.CircuitContext<PS>, tokenId_0: bigint): __compactRuntime.CircuitResults<PS, string>;
  tokenImage(context: __compactRuntime.CircuitContext<PS>, tokenId_0: bigint): __compactRuntime.CircuitResults<PS, string>;
  tokenMediaType(context: __compactRuntime.CircuitContext<PS>, tokenId_0: bigint): __compactRuntime.CircuitResults<PS, string>;
  totalSupply(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, bigint>;
  getApproved(context: __compactRuntime.CircuitContext<PS>, tokenId_0: bigint): __compactRuntime.CircuitResults<PS, ZswapCoinPublicKey>;
  mint(context: __compactRuntime.CircuitContext<PS>,
       to_0: ZswapCoinPublicKey,
       uri_0: string,
       tokenName_0: string,
       image_0: string,
       mediaType_0: string): __compactRuntime.CircuitResults<PS, bigint>;
  transfer(context: __compactRuntime.CircuitContext<PS>,
           to_0: ZswapCoinPublicKey,
           tokenId_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  approve(context: __compactRuntime.CircuitContext<PS>,
          to_0: ZswapCoinPublicKey,
          tokenId_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  setApprovalForAll(context: __compactRuntime.CircuitContext<PS>,
                    operator_0: ZswapCoinPublicKey,
                    approved_0: boolean): __compactRuntime.CircuitResults<PS, []>;
  isApprovedForAll(context: __compactRuntime.CircuitContext<PS>,
                   owner_0: ZswapCoinPublicKey,
                   operator_0: ZswapCoinPublicKey): __compactRuntime.CircuitResults<PS, boolean>;
  burn(context: __compactRuntime.CircuitContext<PS>, tokenId_0: bigint): __compactRuntime.CircuitResults<PS, []>;
}

export type PureCircuits = {
}

export type Circuits<PS> = {
  name(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, string>;
  symbol(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, string>;
  ownerOf(context: __compactRuntime.CircuitContext<PS>, tokenId_0: bigint): __compactRuntime.CircuitResults<PS, ZswapCoinPublicKey>;
  tokenURI(context: __compactRuntime.CircuitContext<PS>, tokenId_0: bigint): __compactRuntime.CircuitResults<PS, string>;
  tokenName(context: __compactRuntime.CircuitContext<PS>, tokenId_0: bigint): __compactRuntime.CircuitResults<PS, string>;
  tokenImage(context: __compactRuntime.CircuitContext<PS>, tokenId_0: bigint): __compactRuntime.CircuitResults<PS, string>;
  tokenMediaType(context: __compactRuntime.CircuitContext<PS>, tokenId_0: bigint): __compactRuntime.CircuitResults<PS, string>;
  totalSupply(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, bigint>;
  getApproved(context: __compactRuntime.CircuitContext<PS>, tokenId_0: bigint): __compactRuntime.CircuitResults<PS, ZswapCoinPublicKey>;
  mint(context: __compactRuntime.CircuitContext<PS>,
       to_0: ZswapCoinPublicKey,
       uri_0: string,
       tokenName_0: string,
       image_0: string,
       mediaType_0: string): __compactRuntime.CircuitResults<PS, bigint>;
  transfer(context: __compactRuntime.CircuitContext<PS>,
           to_0: ZswapCoinPublicKey,
           tokenId_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  approve(context: __compactRuntime.CircuitContext<PS>,
          to_0: ZswapCoinPublicKey,
          tokenId_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  setApprovalForAll(context: __compactRuntime.CircuitContext<PS>,
                    operator_0: ZswapCoinPublicKey,
                    approved_0: boolean): __compactRuntime.CircuitResults<PS, []>;
  isApprovedForAll(context: __compactRuntime.CircuitContext<PS>,
                   owner_0: ZswapCoinPublicKey,
                   operator_0: ZswapCoinPublicKey): __compactRuntime.CircuitResults<PS, boolean>;
  burn(context: __compactRuntime.CircuitContext<PS>, tokenId_0: bigint): __compactRuntime.CircuitResults<PS, []>;
}

export type Ledger = {
  readonly collectionName: string;
  readonly collectionSymbol: string;
  readonly collectionImage: string;
  readonly collectionMediaType: string;
  readonly contractOwner: ZswapCoinPublicKey;
  readonly transferable: boolean;
  readonly nextTokenId: bigint;
  owners: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: bigint): boolean;
    lookup(key_0: bigint): ZswapCoinPublicKey;
    [Symbol.iterator](): Iterator<[bigint, ZswapCoinPublicKey]>
  };
  tokenURIs: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: bigint): boolean;
    lookup(key_0: bigint): string;
    [Symbol.iterator](): Iterator<[bigint, string]>
  };
  tokenNames: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: bigint): boolean;
    lookup(key_0: bigint): string;
    [Symbol.iterator](): Iterator<[bigint, string]>
  };
  tokenImages: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: bigint): boolean;
    lookup(key_0: bigint): string;
    [Symbol.iterator](): Iterator<[bigint, string]>
  };
  tokenMediaTypes: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: bigint): boolean;
    lookup(key_0: bigint): string;
    [Symbol.iterator](): Iterator<[bigint, string]>
  };
  balanceMap: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: ZswapCoinPublicKey): boolean;
    lookup(key_0: ZswapCoinPublicKey): { read(): bigint }
  };
  tokenApprovals: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: bigint): boolean;
    lookup(key_0: bigint): ZswapCoinPublicKey;
    [Symbol.iterator](): Iterator<[bigint, ZswapCoinPublicKey]>
  };
  operatorApprovals: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: ZswapCoinPublicKey): boolean;
    lookup(key_0: ZswapCoinPublicKey): {
      isEmpty(): boolean;
      size(): bigint;
      member(key_1: ZswapCoinPublicKey): boolean;
      lookup(key_1: ZswapCoinPublicKey): boolean;
      [Symbol.iterator](): Iterator<[ZswapCoinPublicKey, boolean]>
    }
  };
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
               _symbol_1: string,
               _owner_0: ZswapCoinPublicKey,
               _transferable_0: boolean,
               _image_0: string,
               _mediaType_0: string): __compactRuntime.ConstructorResult<PS>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
