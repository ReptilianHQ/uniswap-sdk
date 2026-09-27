#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { concatHex, createPublicClient, encodeAbiParameters, http, keccak256, toHex } from 'viem';

const CORE_COMMIT = '534603a5bc10d41d57a1c9c34417d472f0dbc0d3';
const ROUTER_COMMIT = '02fd1760fa7c05096833c03e01a4143f963c350e';
const MANIFEST_COMMIT = '047d585853f89726c0fdef46bbf633bab8fc9051';
const MANIFEST_SHA256 = '77b5e8cef3cfe81b723082b0a44918a0c33c039706c80e09dbb702b996fea301';

const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  const value = process.argv[index + 1];
  if (!flag?.startsWith('--') || !value) usage();
  values.set(flag, value);
}

const coreCheckout = values.get('--uniswap-contracts');
const routerCheckout = values.get('--universal-router-contracts') ?? coreCheckout;
const manifestCheckout = values.get('--deployment-manifest');
const anvilRpc = values.get('--anvil-rpc');
if (!coreCheckout || !routerCheckout || !manifestCheckout) usage();

const coreRoot = resolve(coreCheckout);
const routerRoot = resolve(routerCheckout);
const manifestRoot = resolve(manifestCheckout);
assertCommit(coreRoot, CORE_COMMIT);
assertCommit(routerRoot, ROUTER_COMMIT);
assertCommit(manifestRoot, MANIFEST_COMMIT);
const manifestPath = resolve(manifestRoot, 'deployments/json/5042.json');
const manifestSource = readFileSync(manifestPath, 'utf8');
const manifestSha256 = createHash('sha256').update(manifestSource).digest('hex');
if (manifestSha256 !== MANIFEST_SHA256) {
  throw new Error(`${manifestPath} SHA-256 mismatch: expected ${MANIFEST_SHA256}, got ${manifestSha256}`);
}
const manifest = JSON.parse(manifestSource);

const poolManager = '0x8366a39CC670B4001A1121B8F6A443A643e40951';
const permit2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const wrappedNativeUnsupported = '0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f';
const positionManager = '0x6049c9a0e26405C0985f9E3685C87d0aE917f82B';

const records = [
  {
    name: 'poolManager', root: coreRoot,
    manifestName: 'PoolManager',
    address: poolManager,
    artifact: 'src/briefcase/deployers/v4-core/PoolManagerDeployer.sol',
    sourcePackagePath: 'src/pkgs/v4-core', sourcePackageCommit: '46c6834698c48bc4a463a86d8420f4eb1d7f3b75',
    args: encodeAbiParameters([{ type: 'address' }], ['0x9701fb0aDe1E269c8f64Ec0C7b3cfADB31A13A52']),
    expected: '0x1debe8d2bf707a0cea57ce3cdf7b399d61515897a5698b37050d2d5df0a95b2c',
    deploymentTransaction: '0x2a3f2686d0dfc0e8bea88ec2dd006d0cb788410a5d24a946c8d638a32868341e',
    deploymentManifestInputHash: '0x3bdcc016bd6b2f8a19e20bdfa136abbf66ffa7904f42dafa1f5c399e9758544c',
    runtimeCodeHash: '0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626',
    selfAddressOccurrences: 1,
  },
  {
    name: 'stateView', root: coreRoot,
    manifestName: 'StateView',
    address: '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b',
    artifact: 'src/briefcase/deployers/v4-periphery/StateViewDeployer.sol',
    sourcePackagePath: 'src/pkgs/v4-periphery', sourcePackageCommit: '9dafaaecc1e2e1e824eda9d941085f96517d827b',
    args: encodeAbiParameters([{ type: 'address' }], [poolManager]),
    expected: '0xd1a3b7780b831fbddf3407643b70cd7fc1af1140b0e41ad5f10ff74aac004a82',
    deploymentTransaction: '0xc98e1282cf14d5e63f1f8040403d476b92a5dca03bc838ba0b28bf9cfd42bd2f',
    deploymentManifestInputHash: '0x0e2e13349f8e16c9ea97b0167f2747efd891690c087723e0a920356d274593d3',
    runtimeCodeHash: '0x7d9c591e0956fd89d98feb4ffcfe8bf1f7a62bd485edd979fa21d104b49878a6',
    selfAddressOccurrences: 0,
  },
  {
    name: 'positionManager', root: coreRoot,
    manifestName: 'PositionManager',
    address: positionManager,
    artifact: 'src/briefcase/deployers/v4-periphery/PositionManagerDeployer.sol',
    sourcePackagePath: 'src/pkgs/v4-periphery', sourcePackageCommit: '9dafaaecc1e2e1e824eda9d941085f96517d827b',
    args: encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }],
      [poolManager, permit2, 300_000n, '0x516b8a945700D6bBfDeDaa6dcFc4586bA60B8707', wrappedNativeUnsupported],
    ),
    expected: '0x991742c2de2496144a6f8dce18252393a7d50116b8a3ab320100061d8b6dcca6',
    deploymentTransaction: '0xf3abd73072ecc78cbaa6b23de7c2fb56e69edce1dddefa069155198295b2abd2',
    deploymentManifestInputHash: '0xb86b0eed6fd57117c2096f57f07f3e2b4644f2c379e1604cab08790aaa9c40bd',
    runtimeCodeHash: '0x5904204586f0290499c357cfcb99489cdc13740b3cd3f26c735f7ef7f2cff1c5',
    selfAddressOccurrences: 0,
    domainSeparatorOccurrences: 1,
    eip712DomainName: 'Uniswap v4 Positions NFT',
  },
  {
    name: 'quoter', root: coreRoot,
    manifestName: 'V4Quoter',
    address: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
    artifact: 'src/briefcase/deployers/v4-periphery/V4QuoterDeployer.sol',
    sourcePackagePath: 'src/pkgs/v4-periphery', sourcePackageCommit: '9dafaaecc1e2e1e824eda9d941085f96517d827b',
    args: encodeAbiParameters([{ type: 'address' }], [poolManager]),
    expected: '0xd915642b6f3b5375c0096fd70eb15cc0676651fa7d588accd1c6002936bb19c2',
    deploymentTransaction: '0xb8d7a967c1be562fc9de8f5284a110e631f0fea17eef552852fec6ef67e4844a',
    deploymentManifestInputHash: '0xdb731ce141d9e731a17e60e47d1c0582c9c8684bf76430794d47d1d71fac6260',
    runtimeCodeHash: '0xd707b1da8cb165e5ea35a3b4450d971eb562ec171e23492aa117036b78a868f6',
    selfAddressOccurrences: 0,
  },
  {
    name: 'universalRouter', root: routerRoot,
    manifestName: 'UniversalRouter',
    address: '0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1',
    artifact: 'src/briefcase/deployers/universal-router/UniversalRouterDeployer.sol',
    sourcePackagePath: 'src/pkgs/universal-router', sourcePackageCommit: '999d561c3ad58fb5cab91b602911f3c75591a9c7',
    args: encodeAbiParameters([{
      type: 'tuple',
      components: [
        { name: 'permit2', type: 'address' },
        { name: 'weth9', type: 'address' },
        { name: 'v2Factory', type: 'address' },
        { name: 'v3Factory', type: 'address' },
        { name: 'pairInitCodeHash', type: 'bytes32' },
        { name: 'poolInitCodeHash', type: 'bytes32' },
        { name: 'v4PoolManager', type: 'address' },
        { name: 'v3NFTPositionManager', type: 'address' },
        { name: 'v4PositionManager', type: 'address' },
        { name: 'spokePool', type: 'address' },
      ],
    }], [{
      permit2,
      weth9: wrappedNativeUnsupported,
      v2Factory: '0x89e5DB8B5aA49aA85AC63f691524311AEB649eba',
      v3Factory: '0xf0db7b58379503491d857dB50AC9ece64c653918',
      pairInitCodeHash: '0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f',
      poolInitCodeHash: '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54',
      v4PoolManager: poolManager,
      v3NFTPositionManager: '0x39654A85A4C05127f5Fd6ED22CAeC077A0fB1377',
      v4PositionManager: positionManager,
      spokePool: wrappedNativeUnsupported,
    }]),
    expected: '0x8f564cfb262952d7d24e1750426672ccf3a72ca9268e2ec6d97cf846eaae179c',
    deploymentTransaction: '0xf07bb4c6eaccb5b7e128625b0c4fc6bc79f727f9b647a6e81a886bde905345b8',
    deploymentManifestInputHash: '0xe388b0b5ed9c81077f8fcd9a1724fb35b2c5792380dddd3a19fd02f5bc037f77',
    runtimeCodeHash: '0x7f949fe75d3483670e17a9ab398a3dc71f285026bba755b48fffd1e42aefad71',
    selfAddressOccurrences: 1,
    domainSeparatorOccurrences: 1,
    eip712DomainName: 'UniversalRouter',
    eip712DomainVersion: '2',
  },
];

let failed = false;
const creations = [];
for (const record of records) {
  assertGitlink(record.root, record.sourcePackagePath, record.sourcePackageCommit);
  assertManifestRecord(manifest, record);
  const initcode = extractInitcode(resolve(record.root, record.artifact));
  const creationCode = concatHex([initcode, record.args]);
  const actual = keccak256(creationCode);
  if (actual !== record.expected) {
    process.stderr.write(`not ok - ${record.name}: expected ${record.expected}, got ${actual}\n`);
    failed = true;
    continue;
  }
  creations.push({ ...record, creationCode });
  process.stdout.write(`ok - ${record.name}: ${actual}\n`);
}
if (failed) {
  process.exitCode = 1;
} else if (anvilRpc) {
  await verifyRuntimeReproduction(anvilRpc, creations);
}

function assertCommit(root, expected) {
  const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (actual !== expected) throw new Error(`${root} must be checked out at ${expected}; got ${actual}`);
}

function assertGitlink(root, path, expected) {
  const entry = execFileSync('git', ['ls-tree', 'HEAD', path], { cwd: root, encoding: 'utf8' }).trim();
  const actual = entry.split(/\s+/)[2];
  if (actual !== expected) throw new Error(`${root}:${path} must point to ${expected}; got ${actual ?? 'nothing'}`);
}

function extractInitcode(path) {
  const source = readFileSync(path, 'utf8');
  const match = source.match(/function initcode\(\)[\s\S]*?return hex'([0-9a-f]+)'/i);
  if (!match) throw new Error(`Unable to extract generated initcode from ${path}`);
  return `0x${match[1]}`;
}

function assertManifestRecord(source, record) {
  const candidates = [source.latest, ...source.history.map(entry => entry.contracts ?? {})]
    .map(contracts => contracts[record.manifestName])
    .filter(Boolean);
  const entry = candidates.find(candidate => candidate.address.toLowerCase() === record.address.toLowerCase());
  if (!entry) throw new Error(`Manifest has no ${record.manifestName} entry for ${record.address}`);
  const expected = {
    deploymentTxn: record.deploymentTransaction.toLowerCase(),
    initcodeHash: record.deploymentManifestInputHash.slice(2).toLowerCase(),
    proxy: false,
  };
  for (const [field, value] of Object.entries(expected)) {
    const actual = typeof entry[field] === 'string' ? entry[field].toLowerCase() : entry[field];
    if (actual !== value) {
      throw new Error(`Manifest ${record.manifestName}.${field} mismatch: expected ${value}, got ${actual}`);
    }
  }
}

async function verifyRuntimeReproduction(rpcUrl, creationRecords) {
  const client = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await client.getChainId();
  if (chainId !== 5_042) throw new Error(`Anvil chain ID must be 5042; got ${chainId}`);

  const account = '0x0000000000000000000000000000000000005042';
  await client.request({ method: 'anvil_setBalance', params: [account, '0x56bc75e2d63100000'] });
  await client.request({ method: 'anvil_impersonateAccount', params: [account] });
  try {
    for (const record of creationRecords) {
      const hash = await client.request({
        method: 'eth_sendTransaction',
        params: [{ from: account, data: record.creationCode, gas: '0x1c9c380' }],
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success' || !receipt.contractAddress) {
        throw new Error(`${record.name} local reproduction deployment failed`);
      }
      const bytecode = await client.getBytecode({ address: receipt.contractAddress });
      const normalizedBytecode = bytecode
        ? normalizeDeploymentImmutables(
          bytecode,
          receipt.contractAddress,
          record.address,
          record.eip712DomainName,
          record.eip712DomainVersion,
          record.selfAddressOccurrences,
          record.domainSeparatorOccurrences ?? 0,
        )
        : null;
      const actual = normalizedBytecode ? keccak256(normalizedBytecode) : null;
      if (actual !== record.runtimeCodeHash) {
        throw new Error(`${record.name} runtime hash mismatch: expected ${record.runtimeCodeHash}, got ${actual}`);
      }
      process.stdout.write(`ok - ${record.name} runtime: ${actual}\n`);
    }
  } finally {
    await client.request({ method: 'anvil_stopImpersonatingAccount', params: [account] });
  }
}

function normalizeDeploymentImmutables(
  bytecode,
  localAddress,
  deployedAddress,
  eip712DomainName,
  eip712DomainVersion,
  expectedSelfAddressOccurrences,
  expectedDomainSeparatorOccurrences,
) {
  const local = localAddress.slice(2).toLowerCase();
  const deployed = deployedAddress.slice(2).toLowerCase();
  assertOccurrences(bytecode, local, expectedSelfAddressOccurrences, 'deployment address');
  let normalized = bytecode.slice(2).toLowerCase().replaceAll(local, deployed);
  if (eip712DomainName) {
    const localDomain = eip712DomainSeparator(
      eip712DomainName,
      localAddress,
      eip712DomainVersion,
    ).slice(2);
    const deployedDomain = eip712DomainSeparator(
      eip712DomainName,
      deployedAddress,
      eip712DomainVersion,
    ).slice(2);
    assertOccurrences(`0x${normalized}`, localDomain, expectedDomainSeparatorOccurrences, 'EIP-712 domain separator');
    normalized = normalized.replaceAll(localDomain, deployedDomain);
  } else if (expectedDomainSeparatorOccurrences !== 0) {
    throw new Error('Expected EIP-712 domain occurrences without a domain name');
  }
  return `0x${normalized}`;
}

function assertOccurrences(bytecode, value, expected, label) {
  const actual = bytecode.slice(2).toLowerCase().split(value).length - 1;
  if (actual !== expected) throw new Error(`${label} occurrence mismatch: expected ${expected}, got ${actual}`);
}

function eip712DomainSeparator(name, verifyingContract, version) {
  const hasVersion = version !== undefined;
  const typeHash = keccak256(toHex(hasVersion
    ? 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'
    : 'EIP712Domain(string name,uint256 chainId,address verifyingContract)'));
  return keccak256(encodeAbiParameters(
    hasVersion
      ? [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }]
      : [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
    hasVersion
      ? [typeHash, keccak256(toHex(name)), keccak256(toHex(version)), 5_042n, verifyingContract]
      : [typeHash, keccak256(toHex(name)), 5_042n, verifyingContract],
  ));
}

function usage() {
  process.stderr.write('Usage: node scripts/verify-v4-retained-artifacts.mjs --deployment-manifest <047d585 checkout> --uniswap-contracts <534603a checkout> --universal-router-contracts <02fd176 checkout> [--anvil-rpc http://127.0.0.1:8545]\n');
  process.exit(2);
}
