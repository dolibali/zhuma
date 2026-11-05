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

function scopeCorrelation(scope: NativeWorkScope): string {
  return createHash('sha256').update(canonicalPayload(scope)).digest('hex').slice(0, 16);
}

const terminalCodes = new Set([
  'AUTH',
  'NO_ADAPTER',
  'MISSING_CREDENTIAL',
  'INVALID_CREDENTIAL',
  'INVALID_REQUEST',
  'INVALID_ARGS',
  'UNSUPPORTED_REASONING_EFFORT',
  'RATE_LIMIT',
  'QUOTA',
  'ACCOUNT_QUOTA',
  'CONTEXT_WINDOW_EXCEEDED',
  'TIMEOUT',
  'NETWORK',
  'EMPTY_RESPONSE',
  'UNKNOWN',
]);
export interface HostRunTerminalFailure {
  readonly event: 'zhuma-native-run-failed';
  readonly correlation: string;
  readonly stage: 'terminal-history';
  readonly code: string;
}

export function hostRunTerminalDiagnosticsEnabled(): boolean {
  return process.env.ZHUMA_NATIVE_STARTUP_DIAGNOSTICS_STDOUT === '1';
}

function ownData(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  const property = Object.getOwnPropertyDescriptor(value, key);
  return property && 'value' in property ? property.value : undefined;
}

/** Inspect only the last turn boundary in C's existing bounded cut. Never
 * render an error or inspect message/stack/cause, even for malformed ports. */
function terminalCode(snapshot: unknown): string {
  try {
    const events = ownData(snapshot, 'events');
    if (!Array.isArray(events)) return 'unclassified-error';
    const length = ownData(events, 'length');
    // The original snapshot reader permits at most 100 pages of 100 events.
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length > 10_000)
      return 'unclassified-error';
    for (let index = length - 1; index >= 0; index--) {
      const event = ownData(events, String(index));
      if (ownData(event, 'type') !== 'turn/end') continue;
      const reason = ownData(ownData(event, 'data'), 'reason');
      if (ownData(reason, 'kind') !== 'error') return 'unclassified-error';
      const code = ownData(ownData(reason, 'error'), 'code');
      return typeof code === 'string' && terminalCodes.has(code) ? code : 'unclassified-error';
    }
  } catch {
    // A hostile descriptor is unclassified, never a reason to read its value.
  }
  return 'unclassified-error';
}

/** Private opt-in only. The caller must validate original read authority and
 * snapshot/version currency before emitting; this is never a public DTO. */
export function emitHostRunTerminalFailure(
  scope: NativeWorkScope,
  snapshot: unknown,
  emit: (failure: HostRunTerminalFailure) => unknown = (failure) =>
    writeSync(1, `${JSON.stringify(failure)}\n`),
): void {
  if (!hostRunTerminalDiagnosticsEnabled()) return;
  try {
    const pending = emit(
      Object.freeze({
        event: 'zhuma-native-run-failed',
        correlation: scopeCorrelation(scope),
        stage: 'terminal-history',
        code: terminalCode(snapshot),
      }),
    );
    void Promise.resolve(pending).catch(() => undefined);
  } catch {
    // An unavailable acceptance pipe must not change the original read.
  }
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
  const correlation = scopeCorrelation(scope);
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
