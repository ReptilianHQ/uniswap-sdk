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

const require = createRequire(import.meta.url);
const { Ether, Token } = require('@uniswap/sdk-core');
const { Pool } = require('@uniswap/v4-sdk');
const native = Ether.onChain(4663);
const token = new Token(4663, '0x0000000000000000000000000000000000000010', 18);
const zero = '0x0000000000000000000000000000000000000000';
const key = poolKeyFromCurrencies(token, native, 3000, 60, zero);
assert.equal(getV4PoolId(key), Pool.getPoolId(token, native, 3000, 60, zero));
console.log('Native Node ESM exports and official SDK compatibility passed.');
