import assert from 'node:assert/strict';
import {
  readV4Pool,
  readV4TickWindow,
} from '@reptilianhq/uniswap-sdk/v4';
import { isUniswapSdkError } from '@reptilianhq/uniswap-sdk/errors';

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

console.log('Read-only consumer example passed.');
