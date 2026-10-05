import { getAddress, type Address, type Hex } from 'viem';
import { V3_ABI_REVISION } from './v3-abis.js';
import { UniswapSdkError } from './errors.js';
import type { V4Deployment } from './pool.js';

export type UniswapV3DeploymentId = 'robinhood-mainnet-v3' | 'robinhood-testnet-v3';
export type UniswapV3Network = 'robinhood-chain-mainnet' | 'robinhood-chain-testnet';
export type UniswapV3ChainId = 4_663 | 46_630;

export interface UniswapV3Contracts {
  factory: Address;
  nonfungiblePositionManager: Address;
  quoterV2: Address;
  swapRouter02: Address;
  wrappedNative: Address;
  multicall3: Address;
}

export type UniswapV3ContractName = keyof UniswapV3Contracts;
export type UniswapV3RuntimeCodeHashes = Readonly<Record<UniswapV3ContractName, Hex>>;

export interface UniswapV3Deployment {
  id: UniswapV3DeploymentId;
  chainId: UniswapV3ChainId;
  network: UniswapV3Network;
  abiRevision: string;
  provenance: 'official' | 'reviewed-testnet';
  explorerVerification: 'official' | 'partial';
  reviewedAt: string;
  contracts: UniswapV3Contracts;
  runtimeCodeHashes: UniswapV3RuntimeCodeHashes;
}

export type UniswapV4DeploymentId = 'arc-mainnet-v4';
export type UniswapV4Network = 'arc-mainnet';
export type UniswapV4ChainId = 5_042;

export interface UniswapV4Contracts {
  poolManager: Address;
  stateView: Address;
  positionManager: Address;
  quoter: Address;
  universalRouter: Address;
  permit2: Address;
}

export type UniswapV4ContractName = keyof UniswapV4Contracts;
export type UniswapV4RuntimeCodeHashes = Readonly<Record<UniswapV4ContractName, Hex>>;
export type UniswapV4ArtifactBackedContractName = Exclude<UniswapV4ContractName, 'permit2'>;

export interface UniswapV4RetainedArtifact {
  repository: 'https://github.com/Uniswap/contracts';
  sourceCommit: string;
  sourcePackageCommit: string;
  deployerArtifactPath: string;
  sourceContractPath: string;
  deploymentTransaction: Hex;
  generatedInitcodeHash: Hex;
  deploymentManifestInputHash: Hex;
  proxy: false;
}

export interface UniswapV4Deployment extends V4Deployment {
  id: UniswapV4DeploymentId;
  chainId: UniswapV4ChainId;
  network: UniswapV4Network;
  reviewedAt: string;
  referenceBlock: Readonly<{ number: bigint; hash: Hex }>;
  contracts: Readonly<UniswapV4Contracts>;
  runtimeCodeHashes: UniswapV4RuntimeCodeHashes;
  retainedArtifacts: Readonly<Record<UniswapV4ArtifactBackedContractName, UniswapV4RetainedArtifact>>;
  positionManagerWiring: Readonly<{
    wrappedNative: Address;
    tokenDescriptor: Address;
    unsubscribeGasLimit: bigint;
  }>;
  limitations: readonly string[];
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
  runtimeCodeHashes: {
    factory: '0xec72b1abd1f2faee020cfea9c646bd8994f9fb389054f6e574f103a895091739',
    nonfungiblePositionManager: '0x0a493d1af3d0f25fed8efa205244ebee14114267a08647fc38c515c7cd6ead4f',
    quoterV2: '0x3db0868d945e9304c9bc6a8b2181948109ea617647142f3c4083e14393496a28',
    swapRouter02: '0x6f36c378e272c6324c48f045182bcb54bd8ad654cf9ebd42e8893d52c4cb25dc',
    wrappedNative: '0x5706be52f64875fee65a2cec0d80e47a23d8793cbe85d214b48445e2d05f5353',
    multicall3: '0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891',
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
  runtimeCodeHashes: {
    factory: '0x75c5bbc7989daa85188d9e4c9f989271d8bcb2abad3d47e6e47d3c0c5bff02c2',
    nonfungiblePositionManager: '0xe40cd590528ac8b67b428579035fe391e502c38271623777692c50834688e9d5',
    quoterV2: '0x724c4956e1c61fd13285a92685337df60254bc67f775e7268da2fc5cc79d5343',
    swapRouter02: '0xdce781dc17d5f98e3ea0b72d88639a5995ccbba6e11bc01f2057a9409dc8c724',
    wrappedNative: '0x5706be52f64875fee65a2cec0d80e47a23d8793cbe85d214b48445e2d05f5353',
    multicall3: '0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891',
  },
});

const uniswapContractsRepository = 'https://github.com/Uniswap/contracts' as const;
const arcV4SourceCommit = '534603a5bc10d41d57a1c9c34417d472f0dbc0d3';
const arcUniversalRouterSourceCommit = '02fd1760fa7c05096833c03e01a4143f963c350e';
const arcV4Contracts: UniswapV4Contracts = {
  poolManager: getAddress('0x8366a39CC670B4001A1121B8F6A443A643e40951'),
  stateView: getAddress('0xF3334192D15450CdD385c8B70e03f9A6bD9E673b'),
  positionManager: getAddress('0x6049c9a0e26405C0985f9E3685C87d0aE917f82B'),
  quoter: getAddress('0x8dc178efb8111bb0973dd9d722ebeff267c98f94'),
  universalRouter: getAddress('0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1'),
  permit2: getAddress('0x000000000022D473030F116dDEE9F6B43aC78BA3'),
};

/**
 * Official Uniswap v4 infrastructure used by the reviewed Argus Arc flow.
 *
 * This proves only the shared Uniswap contracts. Argus Portal, hook, locker,
 * splitter, and tracker compatibility remains the launcher adapter's gate.
 */
export const arcUniswapV4Mainnet: UniswapV4Deployment = deepFreeze({
  id: 'arc-mainnet-v4',
  chainId: 5_042,
  network: 'arc-mainnet',
  poolManager: arcV4Contracts.poolManager,
  stateView: arcV4Contracts.stateView,
  quoter: arcV4Contracts.quoter,
  reviewedAt: '2026-09-27',
  referenceBlock: {
    number: 20_889_496n,
    hash: '0xf3fd31df5afb9d37a216dda53ac751a6a6c08a9c7e96ce4c07fb0df18d40810b',
  },
  contracts: arcV4Contracts,
  runtimeCodeHashes: {
    poolManager: '0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626',
    stateView: '0x7d9c591e0956fd89d98feb4ffcfe8bf1f7a62bd485edd979fa21d104b49878a6',
    positionManager: '0x5904204586f0290499c357cfcb99489cdc13740b3cd3f26c735f7ef7f2cff1c5',
    quoter: '0xd707b1da8cb165e5ea35a3b4450d971eb562ec171e23492aa117036b78a868f6',
    universalRouter: '0x7f949fe75d3483670e17a9ab398a3dc71f285026bba755b48fffd1e42aefad71',
    permit2: '0x05a793d6bdba8b8715c8f4cef0725ec3a961f567d33ebb2d360f541f19f70c8f',
  },
  retainedArtifacts: {
    poolManager: {
      repository: uniswapContractsRepository,
      sourceCommit: arcV4SourceCommit,
      sourcePackageCommit: '46c6834698c48bc4a463a86d8420f4eb1d7f3b75',
      deployerArtifactPath: 'src/briefcase/deployers/v4-core/PoolManagerDeployer.sol',
      sourceContractPath: 'src/pkgs/v4-core/src/PoolManager.sol',
      deploymentTransaction: '0x2a3f2686d0dfc0e8bea88ec2dd006d0cb788410a5d24a946c8d638a32868341e',
      generatedInitcodeHash: '0x1debe8d2bf707a0cea57ce3cdf7b399d61515897a5698b37050d2d5df0a95b2c',
      deploymentManifestInputHash: '0x3bdcc016bd6b2f8a19e20bdfa136abbf66ffa7904f42dafa1f5c399e9758544c',
      proxy: false,
    },
    stateView: {
      repository: uniswapContractsRepository,
      sourceCommit: arcV4SourceCommit,
      sourcePackageCommit: '9dafaaecc1e2e1e824eda9d941085f96517d827b',
      deployerArtifactPath: 'src/briefcase/deployers/v4-periphery/StateViewDeployer.sol',
      sourceContractPath: 'src/pkgs/v4-periphery/src/lens/StateView.sol',
      deploymentTransaction: '0xc98e1282cf14d5e63f1f8040403d476b92a5dca03bc838ba0b28bf9cfd42bd2f',
      generatedInitcodeHash: '0xd1a3b7780b831fbddf3407643b70cd7fc1af1140b0e41ad5f10ff74aac004a82',
      deploymentManifestInputHash: '0x0e2e13349f8e16c9ea97b0167f2747efd891690c087723e0a920356d274593d3',
      proxy: false,
    },
    positionManager: {
      repository: uniswapContractsRepository,
      sourceCommit: arcV4SourceCommit,
      sourcePackageCommit: '9dafaaecc1e2e1e824eda9d941085f96517d827b',
      deployerArtifactPath: 'src/briefcase/deployers/v4-periphery/PositionManagerDeployer.sol',
      sourceContractPath: 'src/pkgs/v4-periphery/src/PositionManager.sol',
      deploymentTransaction: '0xf3abd73072ecc78cbaa6b23de7c2fb56e69edce1dddefa069155198295b2abd2',
      generatedInitcodeHash: '0x991742c2de2496144a6f8dce18252393a7d50116b8a3ab320100061d8b6dcca6',
      deploymentManifestInputHash: '0xb86b0eed6fd57117c2096f57f07f3e2b4644f2c379e1604cab08790aaa9c40bd',
      proxy: false,
    },
    quoter: {
      repository: uniswapContractsRepository,
      sourceCommit: arcV4SourceCommit,
      sourcePackageCommit: '9dafaaecc1e2e1e824eda9d941085f96517d827b',
      deployerArtifactPath: 'src/briefcase/deployers/v4-periphery/V4QuoterDeployer.sol',
      sourceContractPath: 'src/pkgs/v4-periphery/src/lens/V4Quoter.sol',
      deploymentTransaction: '0xb8d7a967c1be562fc9de8f5284a110e631f0fea17eef552852fec6ef67e4844a',
      generatedInitcodeHash: '0xd915642b6f3b5375c0096fd70eb15cc0676651fa7d588accd1c6002936bb19c2',
      deploymentManifestInputHash: '0xdb731ce141d9e731a17e60e47d1c0582c9c8684bf76430794d47d1d71fac6260',
      proxy: false,
    },
    universalRouter: {
      repository: uniswapContractsRepository,
      sourceCommit: arcUniversalRouterSourceCommit,
      sourcePackageCommit: '999d561c3ad58fb5cab91b602911f3c75591a9c7',
      deployerArtifactPath: 'src/briefcase/deployers/universal-router/UniversalRouterDeployer.sol',
      sourceContractPath: 'src/pkgs/universal-router/contracts/UniversalRouter.sol',
      deploymentTransaction: '0xf07bb4c6eaccb5b7e128625b0c4fc6bc79f727f9b647a6e81a886bde905345b8',
      generatedInitcodeHash: '0x8f564cfb262952d7d24e1750426672ccf3a72ca9268e2ec6d97cf846eaae179c',
      deploymentManifestInputHash: '0xe388b0b5ed9c81077f8fcd9a1724fb35b2c5792380dddd3a19fd02f5bc037f77',
      proxy: false,
    },
  },
  positionManagerWiring: {
    wrappedNative: getAddress('0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f'),
    tokenDescriptor: getAddress('0x516b8a945700D6bBfDeDaa6dcFc4586bA60B8707'),
    unsubscribeGasLimit: 300_000n,
  },
  limitations: [
    'The retained upstream generated initcode and pinned Arc runtime are verified separately because constructor immutables change deployed runtime bytes; this is not a fresh source compilation.',
    'The canonical Permit2 predeploy has an exact runtime pin but is not claimed as an Arc deployment produced by the retained Uniswap/contracts manifest.',
    'Argus Portal, hook, locker, splitter, tracker, fee, custody, and locked-principal semantics are not established by this shared deployment.',
    'The retained v4 Quoter is official infrastructure; hook-aware Argus execution must simulate the exact router call and sender rather than assuming Quoter equivalence.',
  ],
});

export type UniversalRouterDeploymentId = 'arc-mainnet-universal-router' | 'robinhood-mainnet-universal-router';
export type UniversalRouterNetwork = 'arc-mainnet' | 'robinhood-chain-mainnet';
export type UniversalRouterChainId = 5_042 | 4_663;

export interface UniversalRouterContracts {
  universalRouter: Address;
  permit2: Address;
}

export type UniversalRouterContractName = keyof UniversalRouterContracts;

/**
 * A reviewed Universal Router and the Permit2 it pulls through, pinned by exact runtime code
 * hash. Permit2 shares one address on these chains but caches its chain-specific EIP-712
 * domain separator as an immutable, so each chain has its own Permit2 runtime hash.
 */
export interface UniversalRouterDeployment {
  id: UniversalRouterDeploymentId;
  chainId: UniversalRouterChainId;
  network: UniversalRouterNetwork;
  reviewedAt: string;
  /**
   * The block whose hash and runtime bytes the pins were taken at. Absent where the reviewed
   * public RPC serves no historical state; verification then reads the latest block, as the
   * v3 deployments do.
   */
  referenceBlock?: Readonly<{ number: bigint; hash: Hex }>;
  contracts: Readonly<UniversalRouterContracts>;
  runtimeCodeHashes: Readonly<Record<UniversalRouterContractName, Hex>>;
  /** The v4 PoolManager the router's `poolManager()` immutable must name. */
  routerWiring: Readonly<{ poolManager: Address }>;
  limitations: readonly string[];
}

/** Arc's router, derived from the reviewed v4 record so the two pins cannot drift apart. */
export const arcUniversalRouterMainnet: UniversalRouterDeployment = deepFreeze({
  id: 'arc-mainnet-universal-router',
  chainId: arcUniswapV4Mainnet.chainId,
  network: arcUniswapV4Mainnet.network,
  reviewedAt: '2026-10-04',
  referenceBlock: { ...arcUniswapV4Mainnet.referenceBlock },
  contracts: {
    universalRouter: arcUniswapV4Mainnet.contracts.universalRouter,
    permit2: arcUniswapV4Mainnet.contracts.permit2,
  },
  runtimeCodeHashes: {
    universalRouter: arcUniswapV4Mainnet.runtimeCodeHashes.universalRouter,
    permit2: arcUniswapV4Mainnet.runtimeCodeHashes.permit2,
  },
  routerWiring: { poolManager: arcUniswapV4Mainnet.contracts.poolManager },
  limitations: [
    'Source and runtime provenance is the Arc v4 record (provenance/arc-mainnet-v4.json); Permit2 is a canonical-predeploy runtime pin only.',
    'Uniswap/contracts lists a v2.1.2 Universal Router (0x8702463e73f74d0b6765aBceb314Ef07aCb92650) as Arc\'s latest. It is known and deliberately not pinned: the Argus SDK manifest pins this router, and the mined PERMIT2_PERMIT evidence used it.',
  ],
});

export const robinhoodUniversalRouterMainnet: UniversalRouterDeployment = deepFreeze({
  id: 'robinhood-mainnet-universal-router',
  chainId: 4_663,
  network: 'robinhood-chain-mainnet',
  reviewedAt: '2026-10-04',
  contracts: {
    universalRouter: getAddress('0x204FAca1764B154221e35c0d20aBb3c525710498'),
    permit2: getAddress('0x000000000022D473030F116dDEE9F6B43aC78BA3'),
  },
  runtimeCodeHashes: {
    universalRouter: '0x76b92a5bba2dd32019a64eb421f1750e78c6ba044dbfa6840b722eb5ac63d296',
    permit2: '0x5208783f52488f7d3493e5e38311ab707c1d75457fe472a19b0b4d57d66a7fca',
  },
  routerWiring: { poolManager: getAddress('0x8366a39CC670B4001A1121B8F6A443A643e40951') },
  limitations: [
    'This is the Uniswap/contracts manifest\'s latest Robinhood Universal Router (v2.1.2), wired to the production Across SpokePool.',
    'The earlier v2.1.1 router 0x8876789976dEcBfCbBbe364623C63652db8C0904 is labelled orphaned upstream (its Across SpokePool is the UnsupportedProtocol placeholder) and is deliberately not pinned.',
    'The public Robinhood RPC serves no historical state, so runtime hashes are verified at the latest block.',
  ],
});

/** Every reviewed Universal Router. Addresses are pinned here, not read from upstream. */
export const universalRouterDeployments: readonly UniversalRouterDeployment[] = Object.freeze([
  arcUniversalRouterMainnet,
  robinhoodUniversalRouterMainnet,
]);

export function getUniversalRouterDeployment(chainId: number): UniversalRouterDeployment {
  const deployment = universalRouterDeployments.find(candidate => candidate.chainId === chainId);
  if (!deployment) throw new UniswapSdkError('CHAIN_MISMATCH', `No reviewed Universal Router deployment for chain ID ${chainId}`);
  return deployment;
}

/** The reviewed Universal Router for a network key, or undefined when the network has none. */
export function findUniversalRouterDeploymentForNetwork(network: string): UniversalRouterDeployment | undefined {
  return universalRouterDeployments.find(candidate => candidate.network === network);
}

/** Every reviewed Uniswap v3 deployment. Addresses are pinned here, not read from upstream. */
export const uniswapV3Deployments: readonly UniswapV3Deployment[] = Object.freeze([
  robinhoodUniswapV3Mainnet,
  robinhoodUniswapV3Testnet,
]);

/** Every reviewed Uniswap v4 deployment. Addresses are pinned here, not read from upstream. */
export const uniswapV4Deployments: readonly UniswapV4Deployment[] = Object.freeze([arcUniswapV4Mainnet]);

export function getUniswapV3Deployment(chainId: number): UniswapV3Deployment {
  const deployment = uniswapV3Deployments.find(candidate => candidate.chainId === chainId);
  if (!deployment) throw new UniswapSdkError('CHAIN_MISMATCH', `No reviewed Uniswap v3 deployment for chain ID ${chainId}`);
  return deployment;
}

export function getUniswapV4Deployment(chainId: number): UniswapV4Deployment {
  const deployment = uniswapV4Deployments.find(candidate => candidate.chainId === chainId);
  if (!deployment) throw new UniswapSdkError('CHAIN_MISMATCH', `No reviewed Uniswap v4 deployment for chain ID ${chainId}`);
  return deployment;
}

/** The reviewed v3 deployment for a network key, or undefined when the network has none. */
export function findUniswapV3DeploymentForNetwork(network: string): UniswapV3Deployment | undefined {
  return uniswapV3Deployments.find(candidate => candidate.network === network);
}

/** The reviewed v4 deployment for a network key, or undefined when the network has none. */
export function findUniswapV4DeploymentForNetwork(network: string): UniswapV4Deployment | undefined {
  return uniswapV4Deployments.find(candidate => candidate.network === network);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
