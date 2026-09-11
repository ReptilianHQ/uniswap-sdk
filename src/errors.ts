export type UniswapErrorCode = 'INVALID_ARGUMENT' | 'CHAIN_MISMATCH' | 'DEPLOYMENT_MISMATCH' | 'POOL_NOT_FOUND' | 'RPC_ERROR' | 'QUOTE_FAILED' | 'CALLDATA_MISMATCH' | 'EVENT_NOT_FOUND';

export interface UniswapSdkErrorOptions extends ErrorOptions {
  path?: string;
  expected?: string;
  actual?: string;
}

export class UniswapSdkError extends Error {
  public readonly path?: string;
  public readonly expected?: string;
  public readonly actual?: string;

  constructor(public readonly code: UniswapErrorCode, message: string, options: UniswapSdkErrorOptions = {}) {
    super(message, options);
    this.name = 'UniswapSdkError';
    this.path = options.path;
    this.expected = options.expected;
    this.actual = options.actual;
  }
  toJSON() {
    return { name: this.name, code: this.code, message: this.message, path: this.path, expected: this.expected, actual: this.actual };
  }
}

export function isUniswapSdkError(value: unknown): value is UniswapSdkError {
  return value instanceof UniswapSdkError;
}

export function invalid(message: string): never { throw new UniswapSdkError('INVALID_ARGUMENT', message); }

export async function rpc<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (cause) {
    if (cause instanceof UniswapSdkError) throw cause;
    throw new UniswapSdkError('RPC_ERROR', 'Uniswap RPC observation failed', { cause });
  }
}
