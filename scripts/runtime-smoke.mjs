import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { poolKeyFromCurrencies, getV4PoolId } from '../dist/v4.js';
import '../dist/errors.js';
import { buildV4PoolSubscriptions } from '../dist/providers.js';
assert.equal(typeof buildV4PoolSubscriptions, 'function');
import '../dist/index.js';
import '../dist/abis.js';
import {
  buildV3ApprovalTransaction,
  reviewV3ApprovalCalldata,
  robinhoodUniswapV3Testnet,
} from '../dist/v3.js';

const approval = buildV3ApprovalTransaction(
  robinhoodUniswapV3Testnet.contracts.wrappedNative,
  robinhoodUniswapV3Testnet.contracts.nonfungiblePositionManager,
  1n,
);
assert.equal(reviewV3ApprovalCalldata(
  approval.data,
  robinhoodUniswapV3Testnet.contracts.nonfungiblePositionManager,
), 1n);

const { buildV4MintPermitBatchTypedData } = await import('../dist/permit2.js');
const permitTypedData = buildV4MintPermitBatchTypedData({
  chainId: 1,
  spender: '0x0000000000000000000000000000000000000900',
  details: [{ token: '0x0000000000000000000000000000000000000010', amount: 1n, expiration: 9_999_999_999n, nonce: 0n }],
  sigDeadline: 9_999_999_999n,
});
assert.equal(permitTypedData.domain.name, 'Permit2');
assert.equal(permitTypedData.domain.verifyingContract, '0x000000000022D473030F116dDEE9F6B43aC78BA3');

const require = createRequire(import.meta.url);
const { Ether, Token } = require('@uniswap/sdk-core');
const { Pool } = require('@uniswap/v4-sdk');
const native = Ether.onChain(4663);
const token = new Token(4663, '0x0000000000000000000000000000000000000010', 18);
const zero = '0x0000000000000000000000000000000000000000';
const key = poolKeyFromCurrencies(token, native, 3000, 60, zero);
assert.equal(getV4PoolId(key), Pool.getPoolId(token, native, 3000, 60, zero));
console.log('Native Node ESM exports and official SDK compatibility passed.');
