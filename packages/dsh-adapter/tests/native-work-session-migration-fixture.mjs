/** D's phased capability is a contract here; native cleanup/storage remain real. */
export * from './native-work-session-input-fixture.mjs';
export {
  nativeWorkSessionRecordSchema,
  nativeWorkSessionBindingSchema,
  nativeWorkSessionKey,
} from '../dist/native-work-session-record.js';
export { nativeWorkSessionDomainSpec } from '../dist/native-work-session-storage.js';

export function migrationGrant(service, previousScope, selection, partial = {}) {
  const abort = new AbortController(),
    phases = [];
  let allowed = true;
  const data = {
    requestId: 'migration-1',
    inputFingerprint: 'b'.repeat(64),
    previousScope: structuredClone(previousScope),
    scope: {
      ...previousScope,
      runId: 'next-run',
      generation: previousScope.generation + 1,
      segmentId: 'next-segment',
    },
    selection,
    ...partial,
  };
  let boundSignal;
  const authority = {
    ...data,
    signal: abort.signal,
    phases,
    assertCurrent(phase) {
      if (!allowed || abort.signal.aborted) throw Error('contract-migration-authority-rejected');
      phases.push(phase);
      if (this !== authority) throw Error('contract-migration-receiver-rejected');
      if (phase === 'migrate') {
        const ready = service.migrationDrain(data.previousScope);
        if (boundSignal && ready.signal !== boundSignal)
          throw Error('contract-migration-epoch-changed');
        boundSignal = ready.signal;
        ready.assertCurrent();
      }
    },
    revoke() {
      allowed = false;
      abort.abort();
    },
  };
  return authority;
}
