import { createHash } from 'node:crypto';
import { writeSync } from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';
import { canonicalPayload } from '@zhuma/agent-core';
import type { NativeWorkScope } from './native-work-session-contract.js';
import { NativeWorkError } from './native-work-session-contract.js';
import { ExecutionRunError } from './execution-run-state.js';

const stages = [
  'authority',
  'native-send',
  'directory',
  'directory-ready',
  'composition',
  'workspace-binding',
  'model',
  'accepted-inputs',
  'accepted-files',
  'local-tools',
  'output-files',
  'result-tool',
  'resource-retirement',
  'resource-preparation',
  'resource-adoption',
  'tool-manifest',
  'observation',
  'composition-ready',
  'receipt',
] as const;
export type HostRunStartupStage = (typeof stages)[number];
const nativeCodes = new Set([
  'invalid-request',
  'scope-mismatch',
  'not-started',
  'configuration-mismatch',
  'idempotency-mismatch',
  'capacity',
  'delivery-unknown',
  'binding-state-invalid',
  'migration-conflict',
  'migration-not-ready',
  'migration-unknown',
  'unavailable',
  'cancelled',
]);
const executionCodes = new Set([
  'run-authority-unavailable',
  'run-authority-denied',
  'run-validation',
  'run-scope-mismatch',
  'run-recovery-unavailable',
  'run-migration-pending',
  'run-capacity',
]);
export interface HostRunStartupFailure {
  readonly event: 'zhuma-native-startup-failed';
  readonly correlation: string;
  readonly stage: HostRunStartupStage;
  readonly code: string;
}

/** Existing error sinks retain this at Cordis' default threshold. The private
 * acceptance flag mirrors only this safe record through desktop's stdout pipe. */
export function emitHostRunStartupFailure(
  ctx: Pick<Context, 'logger'>,
  failure: HostRunStartupFailure,
): void {
  try {
    ctx.logger.error('Native Run startup failed.', failure);
  } catch {
    // A broken exporter must not change admission/retirement behavior.
  }
  if (process.env.ZHUMA_NATIVE_STARTUP_DIAGNOSTICS_STDOUT !== '1') return;
  try {
    // One bounded synchronous line avoids an asynchronous stdout EPIPE event.
    writeSync(1, `${JSON.stringify(failure)}\n`);
  } catch {
    // A closed acceptance pipe is never evidence about the native Run.
  }
}

/** Ephemeral Host diagnostics only. Never persist transcripts, errors or authority. */
export function createHostRunStartupDiagnostic(
  scope: NativeWorkScope,
  emit: (failure: HostRunStartupFailure) => unknown,
) {
  const correlation = createHash('sha256')
    .update(canonicalPayload(scope))
    .digest('hex')
    .slice(0, 16);
  let stage: HostRunStartupStage = 'authority',
    reported = false;
  return {
    at(next: HostRunStartupStage) {
      if (!reported && stages.includes(next)) stage = next;
    },
    failed(error: unknown) {
      if (reported) return;
      reported = true;
      try {
        let code = 'unexpected-error';
        if (error instanceof NativeWorkError && nativeCodes.has(error.code)) code = error.code;
        else if (error instanceof ExecutionRunError && executionCodes.has(error.code))
          code = error.code;
        else if (error instanceof DOMException && error.name === 'AbortError') code = 'aborted';
        const pending = emit(
          Object.freeze({ event: 'zhuma-native-startup-failed', correlation, stage, code }),
        );
        void Promise.resolve(pending).catch(() => undefined);
      } catch {
        // Diagnostics must not replace the original unknown/held decision.
      }
    },
  };
}
