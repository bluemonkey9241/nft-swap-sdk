import type {
  BaseProvider,
  TransactionReceipt,
} from '@ethersproject/providers';
import type { ContractTransaction } from '@ethersproject/contracts';
import type { Signer } from '@ethersproject/abstract-signer';
import invariant from 'tiny-invariant';
import warning from 'tiny-warning';
import {
  buildOrder as _buildOrder,
  signOrder as _signOrder,
  fillSignedOrder as _fillSignedOrder,
  approveAsset as _approveAsset,
  verifyOrderSignature as _verifyOrderSignature,
  getApprovalStatus as _getApprovalStatus,
  cancelOrder as _cancelOrder,
  cancelOrders as _cancelOrders,
  estimateGasForFillOrder as _estimateGasForFillOrder,
  estimateGasForApproval as _estimateGasForApproval,
  cancelOrdersUpToNow as _cancelOrdersUpToNow,
  getOrderInfo as _getOrderInfo,
  getAssetsFromOrder as _getAssetsFromOrder,
  hashOrder,
  TransactionOverrides,
  PayableOverrides,
  ApprovalStatus,
  SigningOptions,
} from './pure';
import {
  getEipDomain,
  normalizeOrder as _normalizeOrder,
} from '../utils/order';
import {
  SupportedChainIds,
  EIP712_TYPES,
  Order,
  OrderInfo,
  OrderStatus,
  OrderStatusCodeLookup,
  SignedOrder,
  SupportedTokenTypes,
  SwappableAsset,
  TypedData,
  AddressesForChain,
  BigNumberish,
  ERC20AssetDataSerialized,
  AssetProxyId,
} from './types';
import {
  ExchangeContract,
  ExchangeContract__factory,
  Forwarder__factory,
} from '../contracts';
import {
  convertAssetsToInternalFormat,
  convertAssetToInternalFormat,
  decodeAssetData,
} from '../utils/asset-data';
import {
  getProxyAddressForErcType,
  getForwarderAddress,
  getWrappedNativeToken,
} from '../utils/default-addresses';
import { DEFAUTLT_GAS_BUFFER_MULTIPLES } from '../utils/gas-buffer';
import { sleep } from '../utils/sleep';
import addresses from '../addresses.json';

export interface NftSwapConfig {
  exchangeContractAddress?: string;
  erc20ProxyContractAddress?: string;
  erc721ProxyContractAddress?: string;
  erc1155ProxyContractAddress?: string;
  forwarderContractAddress?: string;
  wrappedNativeTokenContractAddress?: string;
  gasBufferMultiples?: { [chainId: number]: number };
}

export interface INftSwap {
  signOrder: (
    order: Order,
    signerAddress: string,
    signer: Signer,
    signingOptions?: Partial<SigningOptions>
  ) => Promise<SignedOrder>;
  buildOrder: (
    makerAssets: Array<SwappableAsset>,
    takerAssets: Array<SwappableAsset>,
    makerAddress: string,
    orderConfig?: Partial<BuildOrderAdditionalConfig>
  ) => Order;
  loadApprovalStatus: (
    asset: SwappableAsset,
    walletAddress: string,
    approvalOverrides?: Partial<ApprovalOverrides>
  ) => Promise<ApprovalStatus>;
  approveTokenOrNftByAsset: (
    asset: SwappableAsset,
    walletAddress: string,
    approvalTransactionOverrides?: Partial<TransactionOverrides>,
    approvalOverrides?: Partial<ApprovalOverrides>
  ) => Promise<ContractTransaction>;
  fillSignedOrder: (
    signedOrder: SignedOrder,
    fillOrderOverrides?: Partial<FillOrderOverrides>
  ) => Promise<ContractTransaction>;
  awaitTransactionHash: (txHash: string) => Promise<TransactionReceipt>;
  cancelOrder: (order: Order) => Promise<ContractTransaction>;
  waitUntilOrderFilledOrCancelled: (
    order: Order,
    timeoutInMs?: number,
    pollOrderStatusFrequencyInMs?: number,
    throwIfStatusOtherThanFillableOrFilled?: boolean
  ) => Promise<OrderInfo | null>;
  getOrderStatus: (order: Order) => Promise<OrderStatus>;
  getOrderInfo: (order: Order) => Promise<OrderInfo>;
  getOrderHash: (order: Order) => string;
  getTypedData: (
    chainId: number,
    exchangeContractAddress: string,
    order: Order
  ) => TypedData;
  normalizeSignedOrder: (order: SignedOrder) => SignedOrder;
  normalizeOrder: (order: Order) => Order;
  verifyOrderSignature: (
    order: Order,
    signature: string,
    chainId: number,
    exchangeContractAddress: string
  ) => boolean;
  checkIfOrderCanBeFilledWithNativeToken: (order: Order) => boolean;
  getAssetsFromOrder: (order: Order) => {
    makerAssets: SwappableAsset[];
    takerAssets: SwappableAsset[];
  };
}

/**
 * All optional
 */
export interface BuildOrderAdditionalConfig {
  /**
   * If not specified, will be fillable by anyone
   */
  takerAddress?: string;
  /**
   * Date type or unix timestamp when order expires
   */
  expiration?: Date | number;
  /**
   * Unique salt for order, defaults to a unix timestamp
   */
  salt?: string;
  exchangeAddress?: string;
  chainId?: number;
  feeRecipientAddress?: string;
  makerFeeAssetData?: string;
  takerFeeAssetData?: string;
  makerFee?: string;
  takerFee?: string;
}

export interface ApprovalOverrides {
  signer: Signer;
  approve: boolean;
  exchangeProxyContractAddressForAsset: string;
  chainId: number;
  gasAmountBufferMultiple: number | null;
}

export interface FillOrderOverrides {
  signer: Signer;
  exchangeContract: ExchangeContract;
  /**
   * Fill order with native token if possible
   * e.g. If taker asset is WETH, allows order to be filled with ETH
   */
  fillOrderWithNativeTokenInsteadOfWrappedToken: boolean;
  gasAmountBufferMultiple: number | null;
}

/**
 * NftSwap Convenience class to swap between ERC20, ERC721, and ERC1155. Primary entrypoint for swapping.
 */
class NftSwap implements INftSwap {
  public provider: BaseProvider;
  public signer: Signer | undefined;
  public chainId: number;
  public exchangeContract: ExchangeContract;
  public exchangeContractAddress: string;
  public erc20ProxyContractAddress: string;
  public erc721ProxyContractAddress: string;
  public erc1155ProxyContractAddress: string;
  public wrappedNativeTokenContractAddress: string | null;
  public forwarderContractAddress: string | null;
  public gasBufferMultiples: { [chainId: number]: number } | null;

  constructor(
    provider: BaseProvider,
    signer: Signer,
    chainId?: number,
    additionalConfig?: NftSwapConfig
  ) {
    this.provider = provider;
    this.signer = signer;
    this.chainId =
      chainId ?? (this.provider._network.chainId as SupportedChainIds);

    const chainDefaultContractAddresses: AddressesForChain | undefined =
      addresses[this.chainId as SupportedChainIds];

    const zeroExExchangeContractAddress =
      additionalConfig?.exchangeContractAddress ??
      chainDefaultContractAddresses?.exchange;

    warning(
      chainDefaultContractAddresses,
      `Default contract addresses missing for chain ${this.chainId}. Supply ExchangeContract and Asset Proxy contracts manually via additionalConfig argument`
    );

    this.exchangeContractAddress = zeroExExchangeContractAddress;

    this.erc20ProxyContractAddress =
      additionalConfig?.erc20ProxyContractAddress ??
      getProxyAddressForErcType(SupportedTokenTypes.ERC20, this.chainId);
    this.erc721ProxyContractAddress =
      additionalConfig?.erc721ProxyContractAddress ??
      getProxyAddressForErcType(SupportedTokenTypes.ERC721, this.chainId);
    this.erc1155ProxyContractAddress =
      additionalConfig?.erc1155ProxyContractAddress ??
      getProxyAddressForErcType(SupportedTokenTypes.ERC1155, this.chainId);
    this.forwarderContractAddress =
      additionalConfig?.forwarderContractAddress ??
      getForwarderAddress(this.chainId) ??
      null;
    this.wrappedNativeTokenContractAddress =
      additionalConfig?.wrappedNativeTokenContractAddress ??
      getWrappedNativeToken(this.chainId) ??
      null;

    invariant(
      this.exchangeContractAddress,
      '0x V3 Exchange Contract Address not set. Exchange Contract is required to load NftSwap'
    );
    warning(
      this.erc20ProxyContractAddress,
      'ERC20Proxy Contract Address not set, ERC20 swaps will not work'
    );
    warning(
      this.erc721ProxyContractAddress,
      'ERC721Proxy Contract Address not set, ERC721 swaps will not work'
    );
    warning(
      this.erc1155ProxyContractAddress,
      'ERC20Proxy Contract Address not set, ERC1155 swaps will not work'
    );
    warning(
      this.forwarderContractAddress,
      'Forwarder Contract Address not set, native token fills will not work'
    );
    warning(
      this.wrappedNativeTokenContractAddress,
      'WETH Contract Address not set, SDK cannot automatically check if order can be filled with native token'
    );
    warning(this.signer, 'No Signer provided; Read-only mode only.');

    // Initialize Exchange contract so we can interact with it easily.
    this.exchangeContract = ExchangeContract__factory.connect(
      zeroExExchangeContractAddress,
      signer ?? provider
    );

    this.gasBufferMultiples =
      additionalConfig?.gasBufferMultiples ?? DEFAUTLT_GAS_BUFFER_MULTIPLES;
  }

  public cancelOrder = async (order: Order) => {
    return _cancelOrder(this.exchangeContract, order);
  };

  /**
   *
   * @param order : 0x Order;
   * @param timeoutInMs : Timeout in millisecond to give up listening for order fill
   * @param throwIfStatusOtherThanFillableOrFilled : Option to throw if status changes from fillable to anything other than 'filled' (e.g 'cancelled')
   * @returns OrderInfo if status change in order, or null if timed out
   */
  public waitUntilOrderFilledOrCancelled = async (
    order: Order,
    timeoutInMs: number = 60 * 1000,
    pollOrderStatusFrequencyInMs: number = 10_000,
    throwIfStatusOtherThanFillableOrFilled: boolean = false
  ): Promise<OrderInfo | null> => {
    let settled = false;

    const timeoutPromise = sleep(timeoutInMs).then((_) => null);

    const orderStatusRefreshPromiseFn = async (): Promise<OrderInfo | null> => {
      while (!settled) {
        const orderInfo = await this.getOrderInfo(order);
        if (orderInfo.orderStatus === OrderStatus.Fillable) {
          await sleep(pollOrderStatusFrequencyInMs);
          continue;
        } else if (orderInfo.orderStatus === OrderStatus.FullyFilled) {
          return orderInfo;
        } else {
          // expired, bad order, etc
          if (throwIfStatusOtherThanFillableOrFilled) {
            throw new Error(
              OrderStatusCodeLookup[orderInfo.orderStatus] ??
                orderInfo.orderStatus ??
                'Unknown status'
            );
          }
          return orderInfo;
        }
      }
      return null;
    };
    const fillEventListenerFn = async () => {
      // TODO(johnrjj)
      await sleep(timeoutInMs * 2);
      return null;
    };

    const orderStatusRefreshPromiseLoop: Promise<OrderInfo | null> =
      orderStatusRefreshPromiseFn();

    const fillEventPromise: Promise<OrderInfo | null> = fillEventListenerFn();

    const orderInfo = await Promise.any([
      timeoutPromise,
      orderStatusRefreshPromiseLoop,
      fillEventPromise,
    ]);
    settled = true;

    return orderInfo;
  };

  public getOrderInfo = async (order: Order): Promise<OrderInfo> => {
    return _getOrderInfo(this.exchangeContract, order);
  };

  public getOrderStatus = async (order: Order): Promise<OrderStatus> => {
    const orderInfo = await this.getOrderInfo(order);
    return orderInfo.orderStatus;
  };

  public awaitTransactionHash = async (txHash: string) => {
    return this.provider.waitForTransaction(txHash);
  };

  public signOrder = async (
    order: Order,
    addressOfWalletSigningOrder: string,
    signerOverride?: Signer,
    signingOptions?: Partial<SigningOptions>
  ) => {
    const signerToUser = signerOverride ?? this.signer;
    if (!signerToUser) {
      throw new Error('signOrder:Signer undefined');
    }
    return _signOrder(
      order,
      addressOfWalletSigningOrder,
      signerToUser,
      this.provider,
      this.chainId,
      this.exchangeContract.address,
      signingOptions
    );
  };

  public buildOrder = (
    makerAssets: SwappableAsset[],
    takerAssets: SwappableAsset[],
    makerAddress: string,
    userConfig?: Partial<BuildOrderAdditionalConfig>
  ) => {
    const defaultConfig = { chainId: this.chainId, makerAddress: makerAddress };
    const config = { ...defaultConfig, ...userConfig };
    return _buildOrder(
      convertAssetsToInternalFormat(makerAssets),
      convertAssetsToInternalFormat(takerAssets),
      config
    );
  };

  public loadApprovalStatus = async (
    asset: SwappableAsset,
    walletAddress: string
  ) => {
    // TODO(johnrjj) - Fix this...
    const exchangeProxyAddressForAsset = getProxyAddressForErcType(
      asset.type as SupportedTokenTypes,
      this.chainId
    );
    const assetInternalFmt = convertAssetToInternalFormat(asset);
    return _getApprovalStatus(
      walletAddress,
      exchangeProxyAddressForAsset,
      assetInternalFmt,
      this.provider
    );
  };

  /**
   * @param asset Asset in the SDK format
   * @returns
   */
  public async approveTokenOrNftByAsset(
    asset: SwappableAsset,
    _walletAddress: string, // Remove in next release
    approvalTransactionOverrides?: Partial<TransactionOverrides>,
    otherOverrides?: Partial<ApprovalOverrides>
  ) {
    // TODO(johnrjj) - Look up via class fields instead...
    const exchangeProxyAddressForAsset =
      otherOverrides?.exchangeProxyContractAddressForAsset ??
      getProxyAddressForErcType(
        asset.type as SupportedTokenTypes,
        this.chainId
      );
    const signerToUse = otherOverrides?.signer ?? this.signer;
    if (!signerToUse) {
      throw new Error('approveTokenOrNftByAsset:Signer null');
    }
    if (otherOverrides?.gasAmountBufferMultiple === null) {
    }
    let gasBufferMultiple: number | undefined = undefined;
    if (otherOverrides?.gasAmountBufferMultiple === null) {
      // keep gasBufferMultiple undefined, b/c user specifically specified null.
      gasBufferMultiple = undefined;
    } else {
      gasBufferMultiple =
        otherOverrides?.gasAmountBufferMultiple ??
        this.getGasMultipleForChainId(this.chainId);
    }
    let maybeCustomGasLimit: BigNumberish | undefined;
    if (gasBufferMultiple) {
      const estimatedGasAmount = await _estimateGasForApproval(
        exchangeProxyAddressForAsset,
        convertAssetToInternalFormat(asset),
        signerToUse,
        approvalTransactionOverrides ?? {},
        otherOverrides?.approve ?? true
      );
      maybeCustomGasLimit = Math.floor(
        estimatedGasAmount.toNumber() * gasBufferMultiple
      );
    }

    return _approveAsset(
      exchangeProxyAddressForAsset,
      convertAssetToInternalFormat(asset),
      signerToUse,
      {
        gasLimit: maybeCustomGasLimit,
        ...approvalTransactionOverrides,
      },
      otherOverrides?.approve ?? true
    );
  }

  public getOrderHash = (order: Order) => {
    return hashOrder(order, this.chainId, this.exchangeContract.address);
  };

  public getTypedData = (
    chainId: number,
    exchangeContractAddress: string,
    order: Order
  ) => {
    const domain = getEipDomain(chainId, exchangeContractAddress);
    const types = EIP712_TYPES;
    const value = order;
    return {
      domain,
      types,
      value,
    };
  };

  /**
   * Decodes readable order data (maker and taker assets) from the Order's encoded asset data
   * @param order : 0x Order (or Signed Order);
   * @returns Maker and taker assets for the order
   */
  public getAssetsFromOrder = (order: Order) => {
    return _getAssetsFromOrder(order);
  };

  public checkIfOrderCanBeFilledWithNativeToken = (
    order: Order,
    wrappedNativeTokenContractAddress: string | undefined = this
      .wrappedNativeTokenContractAddress ?? undefined
  ): boolean => {
    warning(
      this.wrappedNativeTokenContractAddress,
      'Wrapped native token contract address not set. Cannot determine if order can be filled with native token'
    );
    const decodedAssetData = decodeAssetData(order.takerAssetData);

    // Can only fill with native token when taker asset is ERC20. (Multiasset is not supported)
    if (
      decodedAssetData.assetProxyId.toLowerCase() !==
      AssetProxyId.ERC20.toLowerCase()
    ) {
      return false;
    }

    // If we get this far, we have a single asset (non-multiasset) ERC20 for the taker token.
    // Let's check if it is the wrapped native contract address for this chain (e.g. WETH on mainnet or rinkeby, WMATIC on polygon)
    const erc20TokenAddress = (decodedAssetData as ERC20AssetDataSerialized)
      .tokenAddress;
    invariant(
      erc20TokenAddress,
      'ERC20 token address missing from detected ERC20 asset data'
    );

    return (
      erc20TokenAddress.toLowerCase() ===
      wrappedNativeTokenContractAddress?.toLowerCase()
    );
  };

  public fillSignedOrder = async (
    signedOrder: SignedOrder,
    fillOverrides?: Partial<FillOrderOverrides>,
    transactionOverrides: Partial<PayableOverrides> = {}
  ) => {
    const exchangeContract =
      fillOverrides?.exchangeContract ?? this.exchangeContract;
    let gasBufferMultiple: number | undefined = undefined;
    if (fillOverrides?.gasAmountBufferMultiple === null) {
      // keep gasBufferMultiple undefined, b/c user specifically specified null.
      gasBufferMultiple = undefined;
    } else {
      gasBufferMultiple =
        fillOverrides?.gasAmountBufferMultiple ??
        this.getGasMultipleForChainId(this.chainId);
    }
    let maybeCustomGasLimit: BigNumberish | undefined;
    if (gasBufferMultiple) {
      const estimatedGasAmount = await _estimateGasForFillOrder(
        signedOrder,
        exchangeContract
      );
      // NOTE(johnrjj) - Underflow issues, so we convert to number. Gas amounts shouldn't overflow.
      maybeCustomGasLimit = Math.floor(
        estimatedGasAmount.toNumber() * gasBufferMultiple
      );
    }

    const allTxOverrides: Partial<PayableOverrides> = {
      gasLimit: maybeCustomGasLimit,
      ...transactionOverrides,
    };

    if (fillOverrides?.fillOrderWithNativeTokenInsteadOfWrappedToken) {
      const eligibleForNativeTokenFill =
        this.checkIfOrderCanBeFilledWithNativeToken(signedOrder);
      warning(
        eligibleForNativeTokenFill,
        `Order ineligible for native token fill, fill will fail.`
      );
      invariant(
        this.forwarderContractAddress,
        'Forwarder contract address null, cannot fill order in native token'
      );
      const forwarderContract = Forwarder__factory.connect(
        this.forwarderContractAddress,
        this.signer ?? this.provider
      );
      const amountOfEthToFillWith = signedOrder.takerAssetAmount;
      return forwarderContract.marketBuyOrdersWithEth(
        [signedOrder],
        signedOrder.makerAssetAmount,
        [signedOrder.signature],
        [],
        [],
        {
          value: amountOfEthToFillWith,
          ...allTxOverrides,
        }
      );
    }

    return _fillSignedOrder(signedOrder, exchangeContract, allTxOverrides);
  };

  private getGasMultipleForChainId = (chainId: number): number | undefined => {
    if (this.gasBufferMultiples) {
      return this.gasBufferMultiples[this.chainId];
    }
    return undefined;
  };

  public normalizeOrder = (order: Order): Order => {
    const normalizedOrder = _normalizeOrder(order);
    return normalizedOrder as Order;
  };

  public normalizeSignedOrder = (order: SignedOrder): SignedOrder => {
    const normalizedOrder = _normalizeOrder(order);
    return normalizedOrder as SignedOrder;
  };

  public verifyOrderSignature = (
    order: Order,
    signature: string,
    chainId: number,
    exchangeContractAddress: string
  ) => {
    return _verifyOrderSignature(
      order,
      signature,
      chainId,
      exchangeContractAddress
    );
  };
}

export { NftSwap };
