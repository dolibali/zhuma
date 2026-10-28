import type { NativeWorkGrant } from './native-work-session-contract.js';
import type {
  NativeRunOutputFiles,
  NativeOutputFileResourceSource,
} from './native-work-session-output-file-contract.js';

/** Internal authorization substitution only; the original upload implementation remains the writer. */
export type ExecutionOutputFileGrant = Pick<NativeWorkGrant, 'scope' | 'signal'>;
export interface ExecutionOutputFileIssuer<Grant extends ExecutionOutputFileGrant> {
  assertGrant(grant: Grant, action: 'history' | 'send'): void;
}
export interface ExecutionOutputFileResources<Grant extends ExecutionOutputFileGrant> {
  readonly signal: AbortSignal;
  assertCurrent(...args: Parameters<NativeOutputFileResourceSource['assertCurrent']>): undefined;
  assertPublication(
    grant: Grant,
    source: Parameters<NativeOutputFileResourceSource['assertPublication']>[1],
    selectorFingerprint: string,
  ): undefined;
}
export interface ExecutionOutputFilePort<Grant extends ExecutionOutputFileGrant> {
  readCompleted(
    grant: Grant,
    request: Parameters<NativeRunOutputFiles['readCompleted']>[1],
    signal: AbortSignal,
  ): ReturnType<NativeRunOutputFiles['readCompleted']>;
  reserve(
    grant: Grant,
    request: Parameters<NativeRunOutputFiles['reserve']>[1],
    signal: AbortSignal,
  ): ReturnType<NativeRunOutputFiles['reserve']>;
}
