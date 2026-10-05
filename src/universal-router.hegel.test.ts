import { describe, expect, it } from 'vitest';
import * as hegel from '@hegeldev/hegel';
import * as gs from '@hegeldev/hegel/generators';
import { bytesToHex, getAddress, pad, toHex, type Address, type Hex } from 'viem';
import { UniswapSdkError } from './errors.js';
import {
  UNIVERSAL_ROUTER_COMMAND,
  decodePermit2PermitInput,
  decodeUniversalRouterExecute,
  encodePermit2PermitInput,
  encodeUniversalRouterExecute,
  reviewPermit2PermitInput,
} from './universal-router.js';

const SETTINGS = { testCases: 300, derandomize: true, database: hegel.Database.disabled } as const;
const KNOWN = Object.values(UNIVERSAL_ROUTER_COMMAND);
const MAX_UINT48 = (1n << 48n) - 1n;
const MAX_UINT160 = (1n << 160n) - 1n;

function address(tc: hegel.TestCase): Address {
  return getAddress(pad(toHex(tc.draw(gs.bigIntegers({ minValue: 1n, maxValue: MAX_UINT160 }))), { size: 20 }));
}

function bytes(tc: hegel.TestCase, minSize = 0): Hex {
  return bytesToHex(tc.draw(gs.binary({ minSize, maxSize: 160 })));
}

function codeOf(action: () => unknown): string {
  try { action(); return 'no error'; }
  catch (error) {
    if (!(error instanceof UniswapSdkError)) throw error;
    return error.code;
  }
}

describe('Universal Router codec properties', () => {
  it('round-trips every plan of known commands and their inputs exactly', () => {
    hegel.test((tc) => {
      const commands = tc.draw(gs.arrays(gs.sampledFrom(KNOWN), { minSize: 1, maxSize: 8 }))
        .map(command => ({ command, input: bytes(tc), allowRevert: tc.draw(gs.booleans()) }));
      const deadline = tc.draw(gs.bigIntegers({ minValue: 0n, maxValue: (1n << 256n) - 1n }));
      const data = encodeUniversalRouterExecute({ commands, deadline }, { allowRevert: true });
      expect(decodeUniversalRouterExecute(data, { allowRevert: true })).toEqual({ commands, deadline });
      // Without the opt-in, any allow-revert flag fails closed.
      expect(codeOf(() => decodeUniversalRouterExecute(data))).toBe(commands.some(entry => entry.allowRevert) ? 'CALLDATA_MISMATCH' : 'no error');
    }, SETTINGS);
  });

  it('round-trips every in-range PermitSingle and accepts it under its own bounds only', () => {
    hegel.test((tc) => {
      const permitSingle = {
        details: {
          token: address(tc),
          amount: tc.draw(gs.bigIntegers({ minValue: 0n, maxValue: MAX_UINT160 })),
          expiration: tc.draw(gs.bigIntegers({ minValue: 0n, maxValue: MAX_UINT48 })),
          nonce: tc.draw(gs.bigIntegers({ minValue: 0n, maxValue: MAX_UINT48 })),
        },
        spender: address(tc),
        sigDeadline: tc.draw(gs.bigIntegers({ minValue: 0n, maxValue: (1n << 256n) - 1n })),
      };
      const signature = bytes(tc, 1);
      const input = encodePermit2PermitInput(permitSingle, signature);
      expect(decodePermit2PermitInput(input)).toEqual({ permitSingle, signature });
      const exact = {
        token: permitSingle.details.token,
        spender: permitSingle.spender,
        minAmount: permitSingle.details.amount,
        maxAmount: permitSingle.details.amount,
        maxSigDeadline: permitSingle.sigDeadline,
        maxExpiration: permitSingle.details.expiration,
        minExpiration: permitSingle.details.expiration,
        nonce: permitSingle.details.nonce,
      };
      expect(codeOf(() => reviewPermit2PermitInput(input, exact))).toBe('no error');
      if (permitSingle.sigDeadline > 0n) {
        expect(codeOf(() => reviewPermit2PermitInput(input, { ...exact, maxSigDeadline: permitSingle.sigDeadline - 1n }))).toBe('CALLDATA_MISMATCH');
      }
      if (permitSingle.details.amount < MAX_UINT160) {
        expect(codeOf(() => reviewPermit2PermitInput(input, { ...exact, minAmount: permitSingle.details.amount + 1n, maxAmount: MAX_UINT160 }))).toBe('CALLDATA_MISMATCH');
      }
    }, SETTINGS);
  });
});
