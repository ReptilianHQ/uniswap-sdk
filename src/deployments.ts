import { getAddress, type Address } from 'viem';
import { V3_ABI_REVISION } from './v3-abis.js';
import { UniswapSdkError } from './errors.js';

export type RobinhoodUniswapV3DeploymentId = 'robinhood-mainnet-v3' | 'robinhood-testnet-v3';

export interface UniswapV3Contracts {
  factory: Address;
  nonfungiblePositionManager: Address;
  quoterV2: Address;
  swapRouter02: Address;
  wrappedNative: Address;
  multicall3: Address;
}

export interface UniswapV3Deployment {
  id: RobinhoodUniswapV3DeploymentId;
  chainId: number;
  network: 'robinhood-chain-mainnet' | 'robinhood-chain-testnet';
  abiRevision: string;
  provenance: 'official' | 'reviewed-testnet';
  explorerVerification: 'official' | 'partial';
  reviewedAt: string;
  contracts: UniswapV3Contracts;
}

const multicall3 = getAddress('0xca11bde05977b3631167028862be2a173976ca11');

export const robinhoodUniswapV3Mainnet: UniswapV3Deployment = deepFreeze({
  id: 'robinhood-mainnet-v3',
  chainId: 4_663,
  network: 'robinhood-chain-mainnet',
  abiRevision: V3_ABI_REVISION,
  provenance: 'official',
  explorerVerification: 'official',
  reviewedAt: '2026-09-11',
  contracts: {
    factory: getAddress('0x1f7d7550B1b028f7571E69A784071F0205FD2EfA'),
    nonfungiblePositionManager: getAddress('0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3'),
    quoterV2: getAddress('0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7'),
    swapRouter02: getAddress('0xcaf681a66d020601342297493863e78c959e5cb2'),
    wrappedNative: getAddress('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'),
    multicall3,
  },
});

export const robinhoodUniswapV3Testnet: UniswapV3Deployment = deepFreeze({
  id: 'robinhood-testnet-v3',
  chainId: 46_630,
  network: 'robinhood-chain-testnet',
  abiRevision: V3_ABI_REVISION,
  provenance: 'reviewed-testnet',
  explorerVerification: 'partial',
  reviewedAt: '2026-09-11',
  contracts: {
    factory: getAddress('0xdf9e3D6ffaC4513dD7b053212bbECcbCD15ec932'),
    nonfungiblePositionManager: getAddress('0xFFe6CFc4f759b65f9B62c9D05A9E21a78cE93e12'),
    quoterV2: getAddress('0xDDcBe4989C8171F721c5e683C9C6339B59718213'),
    swapRouter02: getAddress('0xb79cB26e90EBBD9bC02c75267c9a86dBa1AFedB7'),
    wrappedNative: getAddress('0x7943e237c7F95DA44E0301572D358911207852Fa'),
    multicall3,
  },
});

export function getRobinhoodUniswapV3Deployment(chainId: number): UniswapV3Deployment {
  if (chainId === robinhoodUniswapV3Mainnet.chainId) return robinhoodUniswapV3Mainnet;
  if (chainId === robinhoodUniswapV3Testnet.chainId) return robinhoodUniswapV3Testnet;
  throw new UniswapSdkError('CHAIN_MISMATCH', `Unsupported Robinhood Uniswap v3 chain ID ${chainId}`);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
