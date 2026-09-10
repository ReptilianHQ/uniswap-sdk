export type UniswapErrorCode = 'INVALID_ARGUMENT' | 'CHAIN_MISMATCH' | 'DEPLOYMENT_MISMATCH' | 'POOL_NOT_FOUND' | 'RPC_ERROR' | 'QUOTE_FAILED';

export class UniswapSdkError extends Error {
  constructor(public readonly code: UniswapErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UniswapSdkError';
  }
  toJSON() { return { name: this.name, code: this.code, message: this.message }; }
}

export function invalid(message: string): never { throw new UniswapSdkError('INVALID_ARGUMENT', message); }

export async function rpc<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (cause) {
    if (cause instanceof UniswapSdkError) throw cause;
    throw new UniswapSdkError('RPC_ERROR', 'Uniswap RPC observation failed', { cause });
  }
}
