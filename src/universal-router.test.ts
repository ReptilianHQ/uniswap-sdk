import { concat, encodeAbiParameters, encodeFunctionData, getAddress, parseAbi, parseAbiParameters, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  UNIVERSAL_ROUTER_COMMAND,
  UNIVERSAL_ROUTER_DEFAULT_COMMANDS,
  UNIVERSAL_ROUTER_FLAG_ALLOW_REVERT,
  UNIVERSAL_ROUTER_MAX_SUB_PLAN_DEPTH,
  decodePermit2PermitInput,
  decodeUniversalRouterExecute,
  encodePermit2PermitInput,
  encodeUniversalRouterExecute,
  encodeUniversalRouterSubPlan,
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
      { commands: [{ command: UNIVERSAL_ROUTER_COMMAND.V4_SWAP, input: '0xabc' as Hex }] },
    ]) {
      expect(() => encodeUniversalRouterExecute({ ...plan, ...bad })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    }
  });
});

describe('Universal Router default commands and sub-plans', () => {
  const C = UNIVERSAL_ROUTER_COMMAND;
  const subPlanParams = parseAbiParameters('bytes commands, bytes[] inputs');
  const rawSubPlan = (commands: Hex, inputs: readonly Hex[]) => encodeAbiParameters(subPlanParams, [commands, inputs]);
  const withSubPlan = (input: Hex) => withCommandBytes('0x0a21', [permitInput, input]);

  it('defaults to a swap-focused allowlist and requires opting into everything else', () => {
    expect([...UNIVERSAL_ROUTER_DEFAULT_COMMANDS].sort((a, b) => a - b)).toEqual([
      C.V3_SWAP_EXACT_IN, C.V3_SWAP_EXACT_OUT, C.SWEEP, C.PAY_PORTION, C.V2_SWAP_EXACT_IN, C.V2_SWAP_EXACT_OUT,
      C.PERMIT2_PERMIT, C.WRAP_ETH, C.UNWRAP_WETH, C.BALANCE_CHECK_ERC20, C.V4_SWAP,
    ]);
    const outside = Object.values(C).filter(command => !UNIVERSAL_ROUTER_DEFAULT_COMMANDS.includes(command));
    expect(outside).toEqual(expect.arrayContaining([C.EXECUTE_SUB_PLAN, C.ACROSS_V4_DEPOSIT_V3, C.TRANSFER, C.PERMIT2_TRANSFER_FROM, C.V4_POSITION_MANAGER_CALL]));
    for (const command of outside) {
      const data = withCommandBytes(`0x0a${command.toString(16).padStart(2, '0')}`, [permitInput, command === C.EXECUTE_SUB_PLAN ? rawSubPlan('0x10', [swapInput]) : swapInput]);
      expect(() => decodeUniversalRouterExecute(data), `0x${command.toString(16)}`).toThrow(expect.objectContaining({ code: 'CALLDATA_MISMATCH' }));
      expect(decodeUniversalRouterExecute(data, { permittedCommands: [C.PERMIT2_PERMIT, C.V4_SWAP, command] }).commands[1]!.command).toBe(command);
    }
  });

  it('reviews a permitted sub-plan under the same options, so allow-revert cannot ride inside it', () => {
    const options = { permittedCommands: [C.PERMIT2_PERMIT, C.EXECUTE_SUB_PLAN, C.SWEEP] };
    // The review's literal exploit, 0x85 (TRANSFER with allow-revert), fails on both counts.
    expect(() => decodeUniversalRouterExecute(withSubPlan(rawSubPlan('0x85', [swapInput])), options)).toThrow(expect.objectContaining({ code: 'CALLDATA_MISMATCH' }));
    // SWEEP is permitted here, so 0x84 isolates the allow-revert gate inside the sub-plan.
    const flagged = withSubPlan(rawSubPlan('0x84', [swapInput]));
    expect(() => decodeUniversalRouterExecute(flagged, options)).toThrow(expect.objectContaining({ code: 'CALLDATA_MISMATCH' }));
    expect(decodeUniversalRouterExecute(flagged, { ...options, allowRevert: [C.SWEEP] }).commands[1]!.subPlan).toEqual([
      { command: C.SWEEP, allowRevert: true, input: swapInput },
    ]);
    // An inner command outside the permitted list fails even though the outer plan is fine.
    expect(() => decodeUniversalRouterExecute(withSubPlan(rawSubPlan('0x05', [swapInput])), options)).toThrow(expect.objectContaining({ code: 'CALLDATA_MISMATCH' }));
    for (const malformed of [rawSubPlan('0x', []), rawSubPlan('0x0404', [swapInput]), swapInput, concat([rawSubPlan('0x04', [swapInput]), '0x00'])]) {
      expect(() => decodeUniversalRouterExecute(withSubPlan(malformed), options)).toThrow(expect.objectContaining({ code: 'CALLDATA_MISMATCH' }));
    }
  });

  it('decodes nested sub-plans up to the depth limit and rejects deeper ones', () => {
    const options = { permittedCommands: [C.PERMIT2_PERMIT, C.EXECUTE_SUB_PLAN, C.SWEEP] };
    let inner = encodeUniversalRouterSubPlan([{ command: C.SWEEP, input: swapInput }], options);
    for (let depth = 1; depth < UNIVERSAL_ROUTER_MAX_SUB_PLAN_DEPTH; depth++) {
      inner = encodeUniversalRouterSubPlan([{ command: C.EXECUTE_SUB_PLAN, input: inner }], options);
    }
    const atLimit = decodeUniversalRouterExecute(withSubPlan(inner), options);
    let level = atLimit.commands[1]!;
    for (let depth = 1; depth < UNIVERSAL_ROUTER_MAX_SUB_PLAN_DEPTH; depth++) level = level.subPlan![0]!;
    expect(level.subPlan).toEqual([{ command: C.SWEEP, allowRevert: false, input: swapInput }]);
    const tooDeep = rawSubPlan('0x21', [inner]);
    expect(() => decodeUniversalRouterExecute(withSubPlan(tooDeep), options)).toThrow(expect.objectContaining({ code: 'CALLDATA_MISMATCH' }));
    expect(() => encodeUniversalRouterSubPlan([{ command: C.EXECUTE_SUB_PLAN, input: inner }], options)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });

  it('builders apply the decoder\'s rules to sub-plans', () => {
    const options = { permittedCommands: [C.PERMIT2_PERMIT, C.EXECUTE_SUB_PLAN, C.SWEEP] };
    expect(() => encodeUniversalRouterSubPlan([{ command: C.SWEEP, input: swapInput, allowRevert: true }], options))
      .toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => encodeUniversalRouterExecute({ deadline: 1n, commands: [{ command: C.EXECUTE_SUB_PLAN, input: rawSubPlan('0x84', [swapInput]) }] }, options))
      .toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    const subPlan = encodeUniversalRouterSubPlan([{ command: C.SWEEP, input: swapInput }], options);
    expect(subPlan).toBe(rawSubPlan('0x04', [swapInput]));
  });

  it('scopes allow-revert to the listed command types only', () => {
    const permitMayRevert = { allowRevert: [C.PERMIT2_PERMIT] };
    const data = encodeUniversalRouterExecute({ deadline: 1n, commands: [{ ...plan.commands[0]!, allowRevert: true }, plan.commands[1]!] }, permitMayRevert);
    expect(decodeUniversalRouterExecute(data, permitMayRevert).commands[0]!.allowRevert).toBe(true);
    expect(() => decodeUniversalRouterExecute(data)).toThrow(expect.objectContaining({ code: 'CALLDATA_MISMATCH' }));
    const swapReverts = withCommandBytes('0x0a90');
    expect(() => decodeUniversalRouterExecute(swapReverts, permitMayRevert)).toThrow(expect.objectContaining({ code: 'CALLDATA_MISMATCH' }));
    for (const bad of [{ allowRevert: [0x80] }, { allowRevert: 'yes' }, { permittedCommands: [-1] }, { permittedCommands: 'all' }]) {
      expect(() => decodeUniversalRouterExecute(data, bad as never)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
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
      { minExpiration: 2_001n, maxExpiration: 3_000n },
      { nonce: 8n },
    ]) {
      expect(() => reviewPermit2PermitInput(permitInput, { ...bounds, ...change }), Object.keys(change).join())
        .toThrow(expect.objectContaining({ code: 'CALLDATA_MISMATCH' }));
    }
  });

  it('rejects missing, mistyped, out-of-range, or inconsistent bounds as INVALID_ARGUMENT', () => {
    const required = ['token', 'spender', 'minAmount', 'maxAmount', 'maxSigDeadline', 'maxExpiration'] as const;
    for (const key of required) {
      expect(() => reviewPermit2PermitInput(permitInput, { ...bounds, [key]: undefined } as never), `missing ${key}`)
        .toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    }
    for (const change of [
      { minAmount: -5n },
      { minAmount: 1 },
      { maxAmount: 1n << 160n },
      { maxSigDeadline: '1500' },
      { maxSigDeadline: 1n << 256n },
      { maxExpiration: 1n << 48n },
      { minExpiration: -1n },
      { minExpiration: 3_000n },
      { nonce: 7 },
      { nonce: 1n << 48n },
      { token: '0x0000000000000000000000000000000000000000' },
      { spender: 'router' },
      { minAmount: 2n, maxAmount: 1n },
    ]) {
      expect(() => reviewPermit2PermitInput(permitInput, { ...bounds, ...change } as never), Object.keys(change).join())
        .toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    }
    expect(() => reviewPermit2PermitInput(permitInput, null as never)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });

  it('treats expiration 0 (expires at the permit block) as satisfying minExpiration', () => {
    const instant = encodePermit2PermitInput({ ...permitSingle, details: { ...permitSingle.details, expiration: 0n } }, signature);
    expect(reviewPermit2PermitInput(instant, bounds).permitSingle.details.expiration).toBe(0n);
  });
});
