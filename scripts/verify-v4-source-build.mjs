#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { concatHex, createPublicClient, encodeAbiParameters, http, keccak256, toHex } from 'viem';

const CORE_COMMIT = '534603a5bc10d41d57a1c9c34417d472f0dbc0d3';
const ROUTER_COMMIT = '02fd1760fa7c05096833c03e01a4143f963c350e';

const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  const value = process.argv[index + 1];
  if (!flag?.startsWith('--') || !value) usage();
  values.set(flag, value);
}

const coreCheckout = values.get('--uniswap-contracts');
const routerCheckout = values.get('--universal-router-contracts') ?? coreCheckout;
const anvilRpc = values.get('--anvil-rpc');
if (!coreCheckout || !routerCheckout) usage();

const coreRoot = resolve(coreCheckout);
const routerRoot = resolve(routerCheckout);
assertCommit(coreRoot, CORE_COMMIT);
assertCommit(routerRoot, ROUTER_COMMIT);

const poolManager = '0x8366a39CC670B4001A1121B8F6A443A643e40951';
const permit2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const wrappedNativeUnsupported = '0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f';
const positionManager = '0x6049c9a0e26405C0985f9E3685C87d0aE917f82B';

const records = [
  {
    name: 'poolManager', root: coreRoot,
    address: poolManager,
    artifact: 'src/briefcase/deployers/v4-core/PoolManagerDeployer.sol',
    sourcePackagePath: 'src/pkgs/v4-core', sourcePackageCommit: '46c6834698c48bc4a463a86d8420f4eb1d7f3b75',
    args: encodeAbiParameters([{ type: 'address' }], ['0x9701fb0aDe1E269c8f64Ec0C7b3cfADB31A13A52']),
    expected: '0x1debe8d2bf707a0cea57ce3cdf7b399d61515897a5698b37050d2d5df0a95b2c',
    runtimeCodeHash: '0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626',
  },
  {
    name: 'stateView', root: coreRoot,
    address: '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b',
    artifact: 'src/briefcase/deployers/v4-periphery/StateViewDeployer.sol',
    sourcePackagePath: 'src/pkgs/v4-periphery', sourcePackageCommit: '9dafaaecc1e2e1e824eda9d941085f96517d827b',
    args: encodeAbiParameters([{ type: 'address' }], [poolManager]),
    expected: '0xd1a3b7780b831fbddf3407643b70cd7fc1af1140b0e41ad5f10ff74aac004a82',
    runtimeCodeHash: '0x7d9c591e0956fd89d98feb4ffcfe8bf1f7a62bd485edd979fa21d104b49878a6',
  },
  {
    name: 'positionManager', root: coreRoot,
    address: positionManager,
    artifact: 'src/briefcase/deployers/v4-periphery/PositionManagerDeployer.sol',
    sourcePackagePath: 'src/pkgs/v4-periphery', sourcePackageCommit: '9dafaaecc1e2e1e824eda9d941085f96517d827b',
    args: encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }],
      [poolManager, permit2, 300_000n, '0x516b8a945700D6bBfDeDaa6dcFc4586bA60B8707', wrappedNativeUnsupported],
    ),
    expected: '0x991742c2de2496144a6f8dce18252393a7d50116b8a3ab320100061d8b6dcca6',
    runtimeCodeHash: '0x5904204586f0290499c357cfcb99489cdc13740b3cd3f26c735f7ef7f2cff1c5',
    eip712DomainName: 'Uniswap v4 Positions NFT',
  },
  {
    name: 'quoter', root: coreRoot,
    address: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
    artifact: 'src/briefcase/deployers/v4-periphery/V4QuoterDeployer.sol',
    sourcePackagePath: 'src/pkgs/v4-periphery', sourcePackageCommit: '9dafaaecc1e2e1e824eda9d941085f96517d827b',
    args: encodeAbiParameters([{ type: 'address' }], [poolManager]),
    expected: '0xd915642b6f3b5375c0096fd70eb15cc0676651fa7d588accd1c6002936bb19c2',
    runtimeCodeHash: '0xd707b1da8cb165e5ea35a3b4450d971eb562ec171e23492aa117036b78a868f6',
  },
  {
    name: 'universalRouter', root: routerRoot,
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
    runtimeCodeHash: '0x7f949fe75d3483670e17a9ab398a3dc71f285026bba755b48fffd1e42aefad71',
    eip712DomainName: 'UniversalRouter',
    eip712DomainVersion: '2',
  },
];

let failed = false;
const creations = [];
for (const record of records) {
  assertGitlink(record.root, record.sourcePackagePath, record.sourcePackageCommit);
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
) {
  const local = localAddress.slice(2).toLowerCase();
  const deployed = deployedAddress.slice(2).toLowerCase();
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
    normalized = normalized.replaceAll(localDomain, deployedDomain);
  }
  return `0x${normalized}`;
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
  process.stderr.write('Usage: node scripts/verify-v4-source-build.mjs --uniswap-contracts <534603a checkout> --universal-router-contracts <02fd176 checkout> [--anvil-rpc http://127.0.0.1:8545]\n');
  process.exit(2);
}
