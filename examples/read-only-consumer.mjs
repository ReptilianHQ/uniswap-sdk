import assert from 'node:assert/strict';
import {
  readV4Pool,
  readV4TickWindow,
} from '@reptilianhq/uniswap-sdk/v4';
import { isUniswapSdkError } from '@reptilianhq/uniswap-sdk/errors';
import { getUniversalRouterDeployment } from '@reptilianhq/uniswap-sdk/deployments';
import { buildPermitSingleTypedData } from '@reptilianhq/uniswap-sdk/permit2';
import {
  UNIVERSAL_ROUTER_COMMAND,
  encodePermit2PermitInput,
  encodeUniversalRouterExecute,
  reviewPermit2PermitInput,
  decodeUniversalRouterExecute,
} from '@reptilianhq/uniswap-sdk/universal-router';

const address = number => `0x${number.toString(16).padStart(40, '0')}`;
const deployment = {
  chainId: 4663,
  poolManager: address(1),
  stateView: address(2),
  quoter: address(3),
};
const poolKey = {
  currency0: address(0),
  currency1: address(4),
  fee: 3_000,
  tickSpacing: 32_767,
  hooks: address(0),
};

// Replace this deterministic client with a configured viem PublicClient.
const publicClient = {
  async getChainId() { return deployment.chainId; },
  async getBlockNumber() { return 100n; },
  async readContract({ functionName, args }) {
    if (functionName === 'poolManager') return deployment.poolManager;
    if (functionName === 'getSlot0') return [1n << 96n, 0, 0, 3_000];
    if (functionName === 'getLiquidity') return 500n;
    if (functionName === 'getTickBitmap') {
      if (args[1] === -1) throw new Error('fixture: bitmap unavailable');
      return 0n;
    }
    throw new Error(`fixture: unexpected ${functionName}`);
  },
};

const pool = await readV4Pool(publicClient, deployment, poolKey);
assert.equal(pool.blockNumber, 100n);
assert.equal(pool.liquidity, 500n);

const ticks = await readV4TickWindow(publicClient, deployment, poolKey, {
  fromWord: -1,
  toWord: 0,
  blockNumber: pool.blockNumber,
});
assert.equal(ticks.partial, true);
assert.deepEqual(ticks.failedWords, [-1]);

try {
  await readV4Pool(publicClient, { ...deployment, chainId: 1 }, poolKey);
  assert.fail('the wrong chain must be rejected');
} catch (error) {
  assert.equal(isUniswapSdkError(error), true);
  assert.equal(error.code, 'CHAIN_MISMATCH');
}

// Fold a router allowance into a Universal Router swap as a signed PermitSingle. The host's
// wallet signs `typedData`; this package never sees a key. The signature here is a placeholder.
const router = getUniversalRouterDeployment(5042);
const deadline = 1_790_881_451n;
const typedData = buildPermitSingleTypedData({
  chainId: router.chainId,
  token: address(4),
  amount: 1_000n,
  expiration: deadline,
  nonce: 0n, // read the current nonce with readPermit2Allowance
  spender: router.contracts.universalRouter,
  sigDeadline: deadline,
});
const signature = `0x${'11'.repeat(65)}`;
const data = encodeUniversalRouterExecute({
  commands: [
    { command: UNIVERSAL_ROUTER_COMMAND.PERMIT2_PERMIT, input: encodePermit2PermitInput(typedData.message, signature) },
    { command: UNIVERSAL_ROUTER_COMMAND.V4_SWAP, input: '0x' /* v4 swap actions */ },
  ],
  deadline,
});

// A reviewer that did not build the calldata checks it before anyone signs the transaction.
const plan = decodeUniversalRouterExecute(data, {
  permittedCommands: [UNIVERSAL_ROUTER_COMMAND.PERMIT2_PERMIT, UNIVERSAL_ROUTER_COMMAND.V4_SWAP],
});
assert.equal(plan.deadline, deadline);
const reviewed = reviewPermit2PermitInput(plan.commands[0].input, {
  token: address(4),
  spender: router.contracts.universalRouter,
  minAmount: 1_000n,
  maxAmount: 1_000n,
  maxSigDeadline: plan.deadline,
  maxExpiration: plan.deadline,
});
assert.equal(reviewed.permitSingle.details.amount, 1_000n);

console.log('Read-only consumer example passed.');
