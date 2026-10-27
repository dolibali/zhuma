import { canonicalPayload } from '@zhuma/agent-core';
import type { ExecutionReviewScope } from './execution-review-contract.js';
import { NativeReviewError } from './native-work-session-review-contract.js';

/** One returned Host handle, retained before validating its shape. This is a
 * physical close obligation, never a result, authorization or drain issuer. */
export interface NativeReviewResourceClosure {
  assertLive(): undefined;
  assertAuthority(): undefined;
  assertClosed(): undefined;
  close(): Promise<void>;
}

export function retainNativeReviewResources(
  adopted: unknown,
  scope: ExecutionReviewScope,
  configurationId: string,
): NativeReviewResourceClosure {
  const unavailable = (): never => {
    throw new NativeReviewError('review-unavailable');
  };
  const object = adopted !== null && typeof adopted === 'object' ? adopted : undefined;
  let captureFailed = false;
  const capture = (key: string): unknown => {
    try {
      return object && Reflect.get(object, key);
    } catch {
      captureFailed = true;
      return undefined;
    }
  };
  // Capture available finalizers first, even when another field is malformed.
  const dispose = capture('dispose'),
    drain = capture('drain'),
    signal = capture('signal'),
    assert = capture('assertCurrent'),
    ready = capture('ready');
  const scopeKey = canonicalPayload(scope);
  let closing: Promise<void> | undefined;
  let closed = false;
  const identity = (): undefined => {
    if (
      !object ||
      captureFailed ||
      typeof dispose !== 'function' ||
      typeof drain !== 'function' ||
      typeof assert !== 'function' ||
      !(signal instanceof AbortSignal) ||
      !ready ||
      typeof Reflect.get(Object(ready), 'then') !== 'function' ||
      Reflect.get(object, 'dispose') !== dispose ||
      Reflect.get(object, 'drain') !== drain ||
      Reflect.get(object, 'signal') !== signal ||
      Reflect.get(object, 'assertCurrent') !== assert ||
      Reflect.get(object, 'ready') !== ready ||
      Reflect.get(object, 'configurationId') !== configurationId ||
      canonicalPayload(Reflect.get(object, 'scope')) !== scopeKey
    )
      return unavailable();
    return undefined;
  };
  const authority = (): undefined => {
    identity();
    if (!(signal instanceof AbortSignal) || signal.aborted) return unavailable();
    return undefined;
  };
  return Object.freeze({
    assertAuthority: authority,
    assertLive() {
      authority();
      const result: unknown = (assert as () => unknown).call(object);
      if (result !== undefined) {
        void Promise.resolve(result).catch(() => undefined);
        return unavailable();
      }
      return authority();
    },
    assertClosed() {
      identity();
      if (!closed) return unavailable();
      return undefined;
    },
    close() {
      if (closing) return closing;
      closing = Promise.resolve().then(async () => {
        let failed = false;
        try {
          identity();
        } catch {
          failed = true;
        }
        for (const finish of [dispose, drain]) {
          if (typeof finish !== 'function') {
            failed = true;
            continue;
          }
          try {
            await finish.call(object);
          } catch {
            failed = true;
          }
        }
        try {
          identity();
        } catch {
          failed = true;
        }
        if (failed) return unavailable();
        closed = true;
      });
      // Rejection is sticky; cancellation of a caller never retries disposal.
      void closing.catch(() => undefined);
      return closing;
    },
  });
}
