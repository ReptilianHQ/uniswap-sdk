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
  'function poolManager() view returns (address)',
  'function permit2() view returns (address)',
  'function WETH9() view returns (address)',
  'function tokenDescriptor() view returns (address)',
  'function unsubscribeGasLimit() view returns (uint256)',
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct AllowanceTransferDetails { address token; uint160 amount; uint48 expiration; uint48 nonce; }',
  'struct AllowanceTransferPermitBatch { AllowanceTransferDetails[] details; address spender; uint256 sigDeadline; }',
  'function initializePool(PoolKey key, uint160 sqrtPriceX96) payable returns (int24)',
  'function modifyLiquidities(bytes unlockData, uint256 deadline) payable',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
  'function permitBatch(address owner, AllowanceTransferPermitBatch permitBatch, bytes signature) payable returns (bytes err)',
]);

// Canonical Permit2 AllowanceTransfer surface: the allowance read and the event its
// `permit` emits. Permit2 caches its EIP-712 domain separator per chain, so the same
// address carries a different runtime hash on every chain; see the reviewed pins.
export const permit2Abi = parseAbi([
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'event Permit(address indexed owner, address indexed token, address indexed spender, uint160 amount, uint48 expiration, uint48 nonce)',
]);
// Universal Router 2.x: only the deadline-bearing `execute` overload is modelled, so
// calldata without an explicit deadline is rejected rather than decoded.
export const universalRouterAbi = parseAbi([
  'function poolManager() view returns (address)',
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
]);

export * from './v3-abis.js';
