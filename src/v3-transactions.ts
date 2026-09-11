import { decodeFunctionData, encodeFunctionData, getAddress, type Address, type Hex } from 'viem';
import { UniswapSdkError } from './errors.js';
import { multicall3Abi, V3_MAX_UINT128, v3Erc20Abi, v3FactoryAbi, v3PositionManagerAbi } from './v3-abis.js';

export type V3TransactionMaterial = { to: Address; data: Hex; value: 0n };
export type V3PositionManagerMulticallMaterial = V3TransactionMaterial & { calls: readonly Hex[] };
export type V3AtomicCall = { target: Address; allowFailure: boolean; callData: Hex };
export type V3AtomicPoolInitializationMaterial = V3TransactionMaterial & { calls: readonly V3AtomicCall[] };

export type V3MintParams = {
  token0: Address; token1: Address; fee: number; tickLower: number; tickUpper: number;
  amount0Desired: bigint; amount1Desired: bigint; amount0Min: bigint; amount1Min: bigint;
  recipient: Address; deadline: bigint;
};

export type V3IncreaseLiquidityParams = {
  tokenId: bigint; amount0Desired: bigint; amount1Desired: bigint;
  amount0Min: bigint; amount1Min: bigint; deadline: bigint;
};

export type V3DecreaseLiquidityParams = {
  tokenId: bigint; liquidity: bigint; amount0Min: bigint; amount1Min: bigint; deadline: bigint;
};

function invalid(message: string): never {
  throw new UniswapSdkError('INVALID_ARGUMENT', message);
}

function mismatch(message: string): never {
  throw new UniswapSdkError('CALLDATA_MISMATCH', message);
}

function same(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function checkedAddress(value: Address, label: string): Address {
  try { return getAddress(value); }
  catch { return invalid(`${label} must be a valid EVM address`); }
}

function uint(value: bigint, bits: number, label: string, allowZero = true): void {
  if (typeof value !== 'bigint' || value < (allowZero ? 0n : 1n) || value >= 1n << BigInt(bits)) {
    invalid(`${label} must be ${allowZero ? '' : 'positive '}uint${bits}`);
  }
}

function fee(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value >= 2 ** 24) invalid('Fee must be uint24');
}

function validateIncrease(params: V3IncreaseLiquidityParams): void {
  uint(params.tokenId, 256, 'Position token ID', false);
  uint(params.amount0Desired, 256, 'Token 0 desired amount');
  uint(params.amount1Desired, 256, 'Token 1 desired amount');
  uint(params.amount0Min, 256, 'Token 0 minimum amount');
  uint(params.amount1Min, 256, 'Token 1 minimum amount');
  uint(params.deadline, 256, 'Deadline', false);
  if (params.amount0Desired === 0n && params.amount1Desired === 0n) invalid('Liquidity increase must include a desired token amount');
  if (params.amount0Min > params.amount0Desired || params.amount1Min > params.amount1Desired) invalid('Liquidity minimums cannot exceed desired amounts');
}

export function buildV3ApprovalTransaction(token: Address, manager: Address, amount: bigint): V3TransactionMaterial {
  uint(amount, 256, 'Approval amount', false);
  return { to: checkedAddress(token, 'Token'), data: encodeFunctionData({ abi: v3Erc20Abi, functionName: 'approve', args: [checkedAddress(manager, 'Position manager'), amount] }), value: 0n };
}

export function buildV3AtomicPoolInitializationTransaction(input: {
  multicall: Address; factory: Address; manager: Address; token0: Address; token1: Address;
  fee: number; sqrtPriceX96: bigint;
}): V3AtomicPoolInitializationMaterial {
  const factory = checkedAddress(input.factory, 'Factory');
  const manager = checkedAddress(input.manager, 'Position manager');
  const token0 = checkedAddress(input.token0, 'Token 0');
  const token1 = checkedAddress(input.token1, 'Token 1');
  if (same(token0, token1)) invalid('Pool tokens must be distinct');
  fee(input.fee);
  uint(input.sqrtPriceX96, 160, 'Initial square-root price', false);
  const calls = [{
    target: factory,
    allowFailure: false,
    callData: encodeFunctionData({ abi: v3FactoryAbi, functionName: 'createPool', args: [token0, token1, input.fee] }),
  }, {
    target: manager,
    allowFailure: false,
    callData: encodeFunctionData({ abi: v3PositionManagerAbi, functionName: 'createAndInitializePoolIfNecessary', args: [token0, token1, input.fee, input.sqrtPriceX96] }),
  }] as const;
  return { to: checkedAddress(input.multicall, 'Multicall'), data: encodeFunctionData({ abi: multicall3Abi, functionName: 'aggregate3', args: [calls] }), value: 0n, calls };
}

export function buildV3MintPositionTransaction(input: {
  manager: Address; params: V3MintParams; initialize?: { sqrtPriceX96: bigint };
}): V3PositionManagerMulticallMaterial {
  const manager = checkedAddress(input.manager, 'Position manager');
  const params = { ...input.params, token0: checkedAddress(input.params.token0, 'Token 0'), token1: checkedAddress(input.params.token1, 'Token 1'), recipient: checkedAddress(input.params.recipient, 'Recipient') };
  if (same(params.token0, params.token1)) invalid('Mint tokens must be distinct');
  fee(params.fee);
  if (!Number.isInteger(params.tickLower) || !Number.isInteger(params.tickUpper) || params.tickLower < -887272 || params.tickUpper > 887272 || params.tickLower >= params.tickUpper) invalid('Mint ticks must be ordered integers in the Uniswap v3 tick range');
  uint(params.amount0Desired, 256, 'Token 0 desired amount');
  uint(params.amount1Desired, 256, 'Token 1 desired amount');
  uint(params.amount0Min, 256, 'Token 0 minimum amount');
  uint(params.amount1Min, 256, 'Token 1 minimum amount');
  uint(params.deadline, 256, 'Deadline', false);
  if (params.amount0Desired === 0n && params.amount1Desired === 0n) invalid('Mint must include a desired token amount');
  if (params.amount0Min > params.amount0Desired || params.amount1Min > params.amount1Desired) invalid('Mint minimums cannot exceed desired amounts');
  if (input.initialize) uint(input.initialize.sqrtPriceX96, 160, 'Initial square-root price', false);
  const mint = encodeFunctionData({ abi: v3PositionManagerAbi, functionName: 'mint', args: [params] });
  const calls = input.initialize
    ? [encodeFunctionData({ abi: v3PositionManagerAbi, functionName: 'createAndInitializePoolIfNecessary', args: [params.token0, params.token1, params.fee, input.initialize.sqrtPriceX96] }), mint]
    : [mint];
  return { to: manager, data: encodeFunctionData({ abi: v3PositionManagerAbi, functionName: 'multicall', args: [calls] }), value: 0n, calls };
}

export function buildV3CollectTransaction(input: { manager: Address; tokenId: bigint; recipient: Address }): V3TransactionMaterial {
  uint(input.tokenId, 256, 'Position token ID', false);
  return {
    to: checkedAddress(input.manager, 'Position manager'),
    data: encodeFunctionData({ abi: v3PositionManagerAbi, functionName: 'collect', args: [{ tokenId: input.tokenId, recipient: checkedAddress(input.recipient, 'Recipient'), amount0Max: V3_MAX_UINT128, amount1Max: V3_MAX_UINT128 }] }),
    value: 0n,
  };
}

export function buildV3IncreaseLiquidityTransaction(input: { manager: Address; params: V3IncreaseLiquidityParams }): V3TransactionMaterial {
  validateIncrease(input.params);
  return { to: checkedAddress(input.manager, 'Position manager'), data: encodeFunctionData({ abi: v3PositionManagerAbi, functionName: 'increaseLiquidity', args: [input.params] }), value: 0n };
}

export function buildV3DecreaseAndCollectTransaction(input: {
  manager: Address; recipient: Address; tokenId: bigint; decrease?: V3DecreaseLiquidityParams; burn?: boolean;
}): V3PositionManagerMulticallMaterial {
  const calls: Hex[] = [];
  uint(input.tokenId, 256, 'Position token ID', false);
  if (input.decrease) {
    uint(input.decrease.tokenId, 256, 'Decrease position token ID', false);
    uint(input.decrease.liquidity, 128, 'Liquidity decrease', false);
    uint(input.decrease.amount0Min, 256, 'Token 0 minimum amount');
    uint(input.decrease.amount1Min, 256, 'Token 1 minimum amount');
    uint(input.decrease.deadline, 256, 'Deadline', false);
    calls.push(encodeFunctionData({ abi: v3PositionManagerAbi, functionName: 'decreaseLiquidity', args: [input.decrease] }));
  }
  if (input.decrease && input.decrease.tokenId !== input.tokenId) invalid('Liquidity decrease targets a different position');
  calls.push(buildV3CollectTransaction({ manager: input.manager, tokenId: input.tokenId, recipient: input.recipient }).data);
  if (input.burn) calls.push(encodeFunctionData({ abi: v3PositionManagerAbi, functionName: 'burn', args: [input.tokenId] }));
  return { to: checkedAddress(input.manager, 'Position manager'), data: encodeFunctionData({ abi: v3PositionManagerAbi, functionName: 'multicall', args: [calls] }), value: 0n, calls };
}

export function buildV3CompoundTransaction(input: {
  manager: Address; recipient: Address; params: V3IncreaseLiquidityParams;
}): V3PositionManagerMulticallMaterial {
  validateIncrease(input.params);
  const collect = buildV3CollectTransaction({ manager: input.manager, tokenId: input.params.tokenId, recipient: input.recipient }).data;
  const increase = buildV3IncreaseLiquidityTransaction({ manager: input.manager, params: input.params }).data;
  const calls = [collect, increase] as const;
  return { to: checkedAddress(input.manager, 'Position manager'), data: encodeFunctionData({ abi: v3PositionManagerAbi, functionName: 'multicall', args: [calls] }), value: 0n, calls };
}

export function reviewV3ApprovalCalldata(data: Hex, manager: Address): bigint {
  try {
    const decoded = decodeFunctionData({ abi: v3Erc20Abi, data });
    if (decoded.functionName !== 'approve' || !same(decoded.args[0], manager) || decoded.args[1] <= 0n) mismatch('Approval calldata does not authorize the reviewed position manager');
    return decoded.args[1];
  } catch (error) {
    if (error instanceof UniswapSdkError) throw error;
    return mismatch('Approval calldata is not a reviewed ERC-20 approval');
  }
}

export function reviewV3AtomicPoolInitializationCalldata(data: Hex, expected: {
  factory: Address; manager: Address; token0: Address; token1: Address; fee?: number; sqrtPriceX96?: bigint;
}): void {
  try {
    const decoded = decodeFunctionData({ abi: multicall3Abi, data });
    if (decoded.functionName !== 'aggregate3' || decoded.args[0].length !== 2 || decoded.args[0].some(call => call.allowFailure)) mismatch('Pool initialization is not a fail-closed two-call batch');
    const [factoryEnvelope, managerEnvelope] = decoded.args[0];
    const factoryCall = decodeFunctionData({ abi: v3FactoryAbi, data: factoryEnvelope.callData });
    const managerCall = decodeFunctionData({ abi: v3PositionManagerAbi, data: managerEnvelope.callData });
    if (!same(factoryEnvelope.target, expected.factory) || factoryCall.functionName !== 'createPool') mismatch('Pool initialization does not use the reviewed factory');
    if (!same(managerEnvelope.target, expected.manager) || managerCall.functionName !== 'createAndInitializePoolIfNecessary') mismatch('Pool initialization does not use the reviewed position manager');
    const pair = [expected.token0.toLowerCase(), expected.token1.toLowerCase()].sort().join(':');
    if ([factoryCall.args[0].toLowerCase(), factoryCall.args[1].toLowerCase()].sort().join(':') !== pair) mismatch('Pool creation terms differ from the reviewed pair');
    if ([managerCall.args[0].toLowerCase(), managerCall.args[1].toLowerCase()].sort().join(':') !== pair || managerCall.args[2] !== factoryCall.args[2]) mismatch('Pool initialization terms differ from the reviewed pair');
    if (expected.fee !== undefined && factoryCall.args[2] !== expected.fee) mismatch('Pool initialization fee differs from the reviewed fee');
    if (expected.sqrtPriceX96 !== undefined && managerCall.args[3] !== expected.sqrtPriceX96) mismatch('Pool initialization price differs from the reviewed price');
  } catch (error) {
    if (error instanceof UniswapSdkError) throw error;
    mismatch('Pool initialization calldata is not a reviewed atomic batch');
  }
}

export function reviewV3MintPositionCalldata(data: Hex, expected: {
  token0: Address; token1: Address; recipient: Address;
}): V3MintParams {
  try {
    const decoded = decodeFunctionData({ abi: v3PositionManagerAbi, data });
    if (decoded.functionName !== 'multicall') mismatch('Mint calldata is not a position-manager multicall');
    const calls = decoded.args[0].map(call => decodeFunctionData({ abi: v3PositionManagerAbi, data: call }));
    if (calls.length < 1 || calls.length > 2) mismatch('Mint calldata must contain only an optional pool initialization followed by one mint');
    const mint = calls.at(-1);
    if (!mint || mint.functionName !== 'mint') return mismatch('Mint calldata must end with one position mint');
    const params = mint.args[0];
    if (calls.length === 2) {
      const initialization = calls[0];
      if (initialization.functionName !== 'createAndInitializePoolIfNecessary') mismatch('Mint calldata contains an unreviewed call before the position mint');
      if (!same(initialization.args[0], params.token0)
        || !same(initialization.args[1], params.token1)
        || initialization.args[2] !== params.fee
        || initialization.args[3] <= 0n) mismatch('Mint pool initialization differs from the position mint');
    }
    const expectedPair = [expected.token0.toLowerCase(), expected.token1.toLowerCase()].sort().join(':');
    if ([params.token0.toLowerCase(), params.token1.toLowerCase()].sort().join(':') !== expectedPair) mismatch('Mint calldata targets a different token pair');
    if (!same(params.recipient, expected.recipient)) mismatch('Mint calldata sends the position NFT to a different recipient');
    return params;
  } catch (error) {
    if (error instanceof UniswapSdkError) throw error;
    return mismatch('Mint calldata contains undecodable position-manager calls');
  }
}

export type ReviewedV3CloseCalldata = { liquidityRemoved: bigint; burned: boolean };

function reviewLiquidityRemoval(data: Hex, recipient: Address, tokenId: bigint, allowBurn: boolean): ReviewedV3CloseCalldata {
  let calls: readonly Hex[];
  try {
    const decoded = decodeFunctionData({ abi: v3PositionManagerAbi, data });
    if (decoded.functionName !== 'multicall') mismatch('Liquidity removal calldata is not a position-manager multicall');
    calls = decoded.args[0];
  } catch (error) {
    if (error instanceof UniswapSdkError) throw error;
    return mismatch('Liquidity removal calldata is not a reviewed position-manager multicall');
  }
  let collected = false; let burned = false; let liquidityRemoved = 0n;
  for (const [index, call] of calls.entries()) {
    try {
      const decoded = decodeFunctionData({ abi: v3PositionManagerAbi, data: call });
      if (decoded.functionName === 'decreaseLiquidity') {
        if (collected || burned) mismatch('Uniswap close transaction cannot remove liquidity after collection');
        if (decoded.args[0].tokenId !== tokenId) mismatch('Uniswap close transaction targets a different position NFT');
        liquidityRemoved += decoded.args[0].liquidity;
      } else if (decoded.functionName === 'collect') {
        const params = decoded.args[0];
        if (collected || burned) mismatch('Uniswap close transaction must collect once after all liquidity-removal calls');
        if (params.tokenId !== tokenId) mismatch('Uniswap close transaction targets a different position NFT');
        if (!same(params.recipient, recipient)) mismatch('Uniswap close transaction collects to a different recipient');
        if (params.amount0Max !== V3_MAX_UINT128 || params.amount1Max !== V3_MAX_UINT128) mismatch('Uniswap close transaction must collect all released token amounts');
        collected = true;
      } else if (decoded.functionName === 'burn') {
        if (!allowBurn) mismatch('Uniswap liquidity-removal transaction cannot burn the position NFT');
        if (burned || !collected || index !== calls.length - 1) mismatch('Uniswap close transaction must burn once after collection');
        if (decoded.args[0] !== tokenId) mismatch('Uniswap close transaction burns a different position NFT');
        burned = true;
      } else mismatch('Liquidity removal contains an unreviewed position-manager call');
    } catch (error) {
      if (error instanceof UniswapSdkError) throw error;
      mismatch('Liquidity removal contains undecodable position-manager calldata');
    }
  }
  if (!collected) mismatch('Uniswap close transaction does not collect the reviewed position NFT');
  return { liquidityRemoved, burned };
}

export function reviewV3LiquidityRemovalCalldata(data: Hex, recipient: Address, tokenId: bigint): bigint {
  const reviewed = reviewLiquidityRemoval(data, recipient, tokenId, false);
  if (reviewed.liquidityRemoved === 0n) mismatch('Uniswap close transaction does not remove position liquidity');
  return reviewed.liquidityRemoved;
}

export function reviewV3CloseCalldata(data: Hex, recipient: Address, tokenId: bigint): ReviewedV3CloseCalldata {
  const reviewed = reviewLiquidityRemoval(data, recipient, tokenId, true);
  if (reviewed.liquidityRemoved === 0n && !reviewed.burned) mismatch('Uniswap close transaction does not remove position liquidity or burn an empty NFT');
  return reviewed;
}

export function reviewV3IncreaseLiquidityCalldata(data: Hex, tokenId: bigint): V3IncreaseLiquidityParams {
  try {
    const decoded = decodeFunctionData({ abi: v3PositionManagerAbi, data });
    if (decoded.functionName !== 'increaseLiquidity') mismatch('Uniswap deposit transaction calldata is not a reviewed liquidity increase');
    if (decoded.args[0].tokenId !== tokenId) mismatch('Uniswap deposit transaction targets a different position NFT');
    if (decoded.args[0].amount0Desired === 0n && decoded.args[0].amount1Desired === 0n) mismatch('Uniswap deposit transaction does not add token amounts');
    return decoded.args[0];
  } catch (error) {
    if (error instanceof UniswapSdkError) throw error;
    return mismatch('Deposit calldata is not a reviewed liquidity increase');
  }
}

export function reviewV3CollectCalldata(data: Hex, recipient: Address, tokenId: bigint): void {
  try {
    const decoded = decodeFunctionData({ abi: v3PositionManagerAbi, data });
    if (decoded.functionName !== 'collect') mismatch('Uniswap fee-claim transaction calldata is not a reviewed collect call');
    if (decoded.args[0].tokenId !== tokenId) mismatch('Uniswap fee-claim transaction targets a different position NFT');
    if (!same(decoded.args[0].recipient, recipient)) mismatch('Uniswap fee-claim transaction collects to a different recipient');
  } catch (error) {
    if (error instanceof UniswapSdkError) throw error;
    mismatch('Fee-claim calldata is not a reviewed collect call');
  }
}

export function reviewV3CompoundCalldata(data: Hex, recipient: Address, tokenId: bigint): void {
  try {
    const decoded = decodeFunctionData({ abi: v3PositionManagerAbi, data });
    if (decoded.functionName !== 'multicall' || decoded.args[0].length !== 2) mismatch('Compound calldata must contain exactly collect and increase calls');
    reviewV3CollectCalldata(decoded.args[0][0], recipient, tokenId);
    reviewV3IncreaseLiquidityCalldata(decoded.args[0][1], tokenId);
  } catch (error) {
    if (error instanceof UniswapSdkError) throw error;
    mismatch('Compound calldata is not a reviewed position-manager multicall');
  }
}
