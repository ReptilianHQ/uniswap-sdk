import { parseAbi } from 'viem';

// Standard v4-core/periphery selectors; extracted from the bot's read surface.
// They do not attest compatibility of a supplied custom deployment.
export const v4StateViewAbi = parseAbi([
  'function poolManager() view returns (address)',
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
  'function getTickBitmap(bytes32 poolId, int16 word) view returns (uint256)',
  'function getTickLiquidity(bytes32 poolId, int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet)',
]);
export const v4QuoterAbi = parseAbi([
  'function poolManager() view returns (address)',
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)',
]);
export const v4PoolManagerAbi = parseAbi([
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
]);
export const v4PositionManagerAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct AllowanceTransferDetails { address token; uint160 amount; uint48 expiration; uint48 nonce; }',
  'struct AllowanceTransferPermitBatch { AllowanceTransferDetails[] details; address spender; uint256 sigDeadline; }',
  'function initializePool(PoolKey key, uint160 sqrtPriceX96) payable returns (int24)',
  'function modifyLiquidities(bytes unlockData, uint256 deadline) payable',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
  'function permitBatch(address owner, AllowanceTransferPermitBatch permitBatch, bytes signature) payable returns (bytes err)',
]);

export * from './v3-abis.js';
