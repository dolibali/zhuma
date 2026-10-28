import type { NativeWorkGrant } from './native-work-session-contract.js';
import type {
  NativeRunAcceptedFiles,
  NativeRunFilePage,
  NativeRunFileResourceSource,
} from './native-work-session-files-contract.js';

/** Internal issuer substitution; fixed inputs, ledger, SDK IO and quotas stay original. */
export type ExecutionAcceptedFileGrant = Pick<NativeWorkGrant, 'scope' | 'signal'>;
export interface ExecutionAcceptedFilePort<Grant extends ExecutionAcceptedFileGrant> {
  list(
    grant: Grant,
    query: Parameters<NativeRunAcceptedFiles['list']>[1],
    signal: AbortSignal,
  ): ReturnType<NativeRunAcceptedFiles['list']>;
  read(
    grant: Grant,
    query: Parameters<NativeRunAcceptedFiles['read']>[1],
    signal: AbortSignal,
  ): Promise<NativeRunFilePage & { readonly drain: Promise<void> }>;
}
export type ExecutionAcceptedFileResources = NativeRunFileResourceSource;
