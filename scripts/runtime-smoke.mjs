import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { poolKeyFromCurrencies, getV4PoolId } from '../dist/v4.js';
import '../dist/errors.js';
import '../dist/index.js';
import '../dist/abis.js';

const require = createRequire(import.meta.url);
const { Ether, Token } = require('@uniswap/sdk-core');
const { Pool } = require('@uniswap/v4-sdk');
const native = Ether.onChain(4663);
const token = new Token(4663, '0x0000000000000000000000000000000000000010', 18);
const zero = '0x0000000000000000000000000000000000000000';
const key = poolKeyFromCurrencies(token, native, 3000, 60, zero);
assert.equal(getV4PoolId(key), Pool.getPoolId(token, native, 3000, 60, zero));
console.log('Native Node ESM exports and official SDK compatibility passed.');
