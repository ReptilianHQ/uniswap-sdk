import { concat, encodeFunctionData, getAddress, parseAbi, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  UNIVERSAL_ROUTER_COMMAND,
  UNIVERSAL_ROUTER_FLAG_ALLOW_REVERT,
  decodePermit2PermitInput,
  decodeUniversalRouterExecute,
  encodePermit2PermitInput,
  encodeUniversalRouterExecute,
  reviewPermit2PermitInput,
} from './universal-router.js';

const token = getAddress('0x0000000000000000000000000000000000000010');
const router = getAddress('0x0000000000000000000000000000000000000900');
const signature = `0x${'11'.repeat(65)}` as Hex;
const permitSingle = {
  details: { token, amount: 1_000n, expiration: 2_000n, nonce: 7n },
  spender: router,
  sigDeadline: 1_500n,
};
const permitInput = encodePermit2PermitInput(permitSingle, signature);
const swapInput = '0xdeadbeef' as Hex;
const plan = {
  commands: [
    { command: UNIVERSAL_ROUTER_COMMAND.PERMIT2_PERMIT, input: permitInput },
    { command: UNIVERSAL_ROUTER_COMMAND.V4_SWAP, input: swapInput },
  ],
  deadline: 1_500n,
};
const twoArgumentExecute = parseAbi(['function execute(bytes commands, bytes[] inputs) payable']);

function withCommandBytes(commands: Hex, inputs: readonly Hex[] = [permitInput, swapInput]): Hex {
  return encodeFunctionData({
    abi: parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']),
    functionName: 'execute',
    args: [commands, inputs, 1_500n],
  });
}

describe('Universal Router execute codec', () => {
  it('round-trips commands, inputs, and deadline', () => {
    const data = encodeUniversalRouterExecute(plan);
    expect(data.slice(0, 10)).toBe('0x3593564c');
    expect(decodeUniversalRouterExecute(data)).toEqual({
      commands: plan.commands.map(entry => ({ ...entry, allowRevert: false })),
      deadline: 1_500n,
    });
  });

  it('rejects allow-revert on both sides unless explicitly permitted', () => {
    const flagged = { ...plan, commands: [plan.commands[0]!, { ...plan.commands[1]!, allowRevert: true }] };
    expect(() => encodeUniversalRouterExecute(flagged)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    const data = encodeUniversalRouterExecute(flagged, { allowRevert: true });
    expect(() => decodeUniversalRouterExecute(data)).toThrow(expect.objectContaining({ code: 'CALLDATA_MISMATCH' }));
    expect(decodeUniversalRouterExecute(data, { allowRevert: true }).commands[1]).toEqual({
      command: UNIVERSAL_ROUTER_COMMAND.V4_SWAP, allowRevert: true, input: swapInput,
    });
    expect(withCommandBytes(`0x0a${(0x10 | UNIVERSAL_ROUTER_FLAG_ALLOW_REVERT).toString(16)}`)).toBe(data);
  });

  it('rejects placeholder and unmodelled command types unless explicitly permitted', () => {
    for (const command of [0x0f, 0x15, 0x22, 0x3f, 0x41, 0x7f]) {
      const data = withCommandBytes(`0x0a${command.toString(16).padStart(2, '0')}`);
      expect(() => decodeUniversalRouterExecute(data), `0x${command.toString(16)}`).toThrow(expect.objectContaining({ code: 'CALLDATA_MISMATCH' }));
      expect(decodeUniversalRouterExecute(data, { permittedCommands: [0x0a, command] }).commands[1]!.command).toBe(command);
      expect(() => encodeUniversalRouterExecute({ ...plan, commands: [{ command, input: swapInput }] })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    }
  });

  it('narrows to a reviewer-supplied command list', () => {
    const data = encodeUniversalRouterExecute(plan);
    expect(() => decodeUniversalRouterExecute(data, { permittedCommands: [UNIVERSAL_ROUTER_COMMAND.V4_SWAP] }))
      .toThrow(expect.objectContaining({ code: 'CALLDATA_MISMATCH' }));
    expect(() => decodeUniversalRouterExecute(data, { permittedCommands: [0x80] })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });

  it('rejects other selectors, count mismatches, empty plans, and trailing bytes', () => {
    const noDeadline = encodeFunctionData({ abi: twoArgumentExecute, functionName: 'execute', args: ['0x0a10', [permitInput, swapInput]] });
    const poolManagerCall = '0xdc4c90d3' as Hex;
    for (const data of [
      noDeadline,
      poolManagerCall,
      withCommandBytes('0x0a'),
      withCommandBytes('0x0a1010'),
      withCommandBytes('0x', []),
      concat([encodeUniversalRouterExecute(plan), '0x00']),
      '0x' as Hex,
    ]) {
      expect(() => decodeUniversalRouterExecute(data), data.slice(0, 20)).toThrow(expect.objectContaining({ code: 'CALLDATA_MISMATCH' }));
    }
  });

  it('rejects invalid plans before encoding', () => {
    for (const bad of [
      { commands: [] },
      { deadline: -1n },
      { deadline: 1n << 256n },
      { commands: [{ command: 0x80, input: swapInput }] },
      { commands: [{ command: 1.5, input: swapInput }] },
      { commands: [{ command: UNIVERSAL_ROUTER_COMMAND.V4_SWAP, input: 'zz' as Hex }] },
    ]) {
      expect(() => encodeUniversalRouterExecute({ ...plan, ...bad })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    }
  });
});

describe('PERMIT2_PERMIT input', () => {
  it('round-trips the PermitSingle and signature', () => {
    expect(decodePermit2PermitInput(permitInput)).toEqual({ permitSingle, signature });
  });

  it('accepts contract-wallet signatures of any nonempty length and rejects an empty one', () => {
    const long = `0x${'22'.repeat(200)}` as Hex;
    expect(decodePermit2PermitInput(encodePermit2PermitInput(permitSingle, long)).signature).toBe(long);
    expect(() => encodePermit2PermitInput(permitSingle, '0x')).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });

  it('rejects an out-of-range or zero-address permit before encoding', () => {
    for (const bad of [
      { ...permitSingle, details: { ...permitSingle.details, amount: 1n << 160n } },
      { ...permitSingle, details: { ...permitSingle.details, nonce: 1n << 48n } },
      { ...permitSingle, spender: getAddress('0x0000000000000000000000000000000000000000') },
    ]) {
      expect(() => encodePermit2PermitInput(bad, signature)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    }
  });

  it('rejects undecodable and non-canonical inputs', () => {
    for (const input of [swapInput, concat([permitInput, '0x00']), '0x' as Hex]) {
      expect(() => decodePermit2PermitInput(input)).toThrow(expect.objectContaining({ code: 'CALLDATA_MISMATCH' }));
    }
  });
});

describe('PERMIT2_PERMIT review', () => {
  const bounds = { token, spender: router, minAmount: 1_000n, maxAmount: 1_000n, maxSigDeadline: 1_500n, maxExpiration: 2_000n, minExpiration: 1_500n, nonce: 7n };

  it('returns the decoded permit when every bound holds, including exact edges', () => {
    expect(reviewPermit2PermitInput(permitInput, bounds)).toEqual({ permitSingle, signature });
    const required = { token, spender: router, minAmount: 1n, maxAmount: 1_000n, maxSigDeadline: 1_500n, maxExpiration: 2_000n };
    expect(reviewPermit2PermitInput(permitInput, required).permitSingle).toEqual(permitSingle);
  });

  it('fails each bound independently', () => {
    const other = getAddress('0x0000000000000000000000000000000000000abc');
    for (const change of [
      { token: other },
      { spender: other },
      { minAmount: 1_001n, maxAmount: 2_000n },
      { maxAmount: 999n, minAmount: 1n },
      { maxSigDeadline: 1_499n },
      { maxExpiration: 1_999n },
      { minExpiration: 2_001n },
      { nonce: 8n },
    ]) {
      expect(() => reviewPermit2PermitInput(permitInput, { ...bounds, ...change }), Object.keys(change).join())
        .toThrow(expect.objectContaining({ code: 'CALLDATA_MISMATCH' }));
    }
    expect(() => reviewPermit2PermitInput(permitInput, { ...bounds, minAmount: 2n, maxAmount: 1n }))
      .toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });
});
