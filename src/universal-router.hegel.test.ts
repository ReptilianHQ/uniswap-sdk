import { describe, expect, it } from 'vitest';
import * as hegel from '@hegeldev/hegel';
import * as gs from '@hegeldev/hegel/generators';
import { bytesToHex, getAddress, pad, toHex, type Address, type Hex } from 'viem';
import { UniswapSdkError } from './errors.js';
import {
  UNIVERSAL_ROUTER_COMMAND,
  UNIVERSAL_ROUTER_DEFAULT_COMMANDS,
  decodePermit2PermitInput,
  decodeUniversalRouterExecute,
  encodePermit2PermitInput,
  encodeUniversalRouterExecute,
  reviewPermit2PermitInput,
} from './universal-router.js';

const SETTINGS = { testCases: 300, derandomize: true, database: hegel.Database.disabled } as const;
// Sub-plans carry structured inputs; they have their own property below.
const FLAT = Object.values(UNIVERSAL_ROUTER_COMMAND).filter(command => command !== UNIVERSAL_ROUTER_COMMAND.EXECUTE_SUB_PLAN);
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
      const commands = tc.draw(gs.arrays(gs.sampledFrom(FLAT), { minSize: 1, maxSize: 8 }))
        .map(command => ({ command, input: bytes(tc), allowRevert: tc.draw(gs.booleans()) }));
      const deadline = tc.draw(gs.bigIntegers({ minValue: 0n, maxValue: (1n << 256n) - 1n }));
      const everything = { permittedCommands: FLAT, allowRevert: true };
      const data = encodeUniversalRouterExecute({ commands, deadline }, everything);
      expect(decodeUniversalRouterExecute(data, everything)).toEqual({ commands, deadline });
      // Default options fail closed on any allow-revert flag or any command outside the swap defaults.
      const outsideDefaults = commands.some(entry => entry.allowRevert || !UNIVERSAL_ROUTER_DEFAULT_COMMANDS.includes(entry.command));
      expect(codeOf(() => decodeUniversalRouterExecute(data))).toBe(outsideDefaults ? 'CALLDATA_MISMATCH' : 'no error');
      // Allow-revert scoped to PERMIT2_PERMIT admits it there and nowhere else.
      const scoped = { permittedCommands: FLAT, allowRevert: [UNIVERSAL_ROUTER_COMMAND.PERMIT2_PERMIT] };
      const revertsElsewhere = commands.some(entry => entry.allowRevert && entry.command !== UNIVERSAL_ROUTER_COMMAND.PERMIT2_PERMIT);
      expect(codeOf(() => decodeUniversalRouterExecute(data, scoped))).toBe(revertsElsewhere ? 'CALLDATA_MISMATCH' : 'no error');
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
