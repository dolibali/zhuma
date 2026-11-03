import {
  canonicalPayload,
  type MemberAssetFileDeclare,
  type MemberAssetReference,
} from '@zhuma/agent-core';
import type { NativeSessionBinding, NativeWorkGrant } from './native-work-session-contract.js';
import type {
  MemberLocalExecutionProtocol,
  MemberLocalRunHandle,
} from './member-local-execution-protocol.js';
import {
  createVerifiedTeamAssetFile,
  type VerifiedTeamAssetFile,
} from './team-asset-file-carrier.js';
import type { TeamAssetFileToolPorts } from './team-asset-file-tool.js';
import { ExecutionRunError } from './execution-run-state.js';

const CACHE_BYTES = 20 * 1024 * 1024;
type Cached = {
  readonly carrier: VerifiedTeamAssetFile;
  readonly file: MemberAssetFileDeclare;
  pins: number;
};

/** Host-private producer over C's original issued Run and signed transport.
 * Cache entries are immutable bytes, never membership or read grants. No file
 * body is read until the original Agent explicitly invokes team_asset. */
export function createHostMemberNativeTeamAssets(options: {
  protocol: MemberLocalExecutionProtocol;
  lifetime: AbortSignal;
  current(signal: AbortSignal): Promise<void>;
  admit(signal: AbortSignal): void;
}) {
  const lifetime = new AbortController(),
    active = new Set<Promise<unknown>>(),
    states = new Map<
      MemberLocalRunHandle,
      { binding: NativeSessionBinding; grant: NativeWorkGrant; ports: TeamAssetFileToolPorts }
    >();
  let drainFailed = false;
  const pending = <T>(promise: Promise<T>): Promise<T> => {
    active.add(promise);
    void promise.then(
      () => active.delete(promise),
      () => active.delete(promise),
    );
    return promise;
  };
  const physical = (drain: Promise<void>) => {
    const tracked = drain.catch((error: unknown) => {
      drainFailed = true;
      throw error;
    });
    return pending(tracked);
  };
  function create(
    binding: NativeSessionBinding,
    grant: NativeWorkGrant,
    run: MemberLocalRunHandle,
  ): TeamAssetFileToolPorts {
    const previous = states.get(run);
    if (previous) {
      if (previous.binding !== binding || previous.grant !== grant)
        throw new ExecutionRunError('run-scope-mismatch');
      return previous.ports;
    }
    const { backendId: _backendId, ...scope } = run.value.scope,
      snapshot = run.composition,
      identity = canonicalPayload(scope),
      bindingIdentity = canonicalPayload(binding),
      signal = AbortSignal.any([lifetime.signal, options.lifetime, grant.signal]);
    if (
      snapshot.schemaVersion !== 2 ||
      !snapshot.payload.teamAssets ||
      !snapshot.payload.teamAssetTool ||
      canonicalPayload(snapshot.payload.scope) !== identity ||
      canonicalPayload(binding.scope) !== identity ||
      canonicalPayload(grant.scope) !== identity
    )
      throw new ExecutionRunError('run-scope-mismatch');
    const files = snapshot.payload.teamAssets.files,
      cache = new Map<string, Cached>();
    let used = 0;
    const check = (operationSignal: AbortSignal, reference?: MemberAssetReference) => {
      signal.throwIfAborted();
      operationSignal.throwIfAborted();
      options.admit(operationSignal);
      grant.assertCurrent('send');
      if (
        canonicalPayload(binding) !== bindingIdentity ||
        canonicalPayload(grant.scope) !== identity
      )
        throw new ExecutionRunError('run-scope-mismatch');
      options.protocol.assertReadBinding(run, binding);
      if (reference) options.protocol.assertTeamAssetFile(run, reference);
    };
    check(signal);
    signal.addEventListener(
      'abort',
      () => {
        for (const value of cache.values()) used -= value.file.byteSize;
        cache.clear();
        states.delete(run);
      },
      { once: true },
    );
    const current = async (operationSignal: AbortSignal, reference?: MemberAssetReference) => {
      const bounded = AbortSignal.any([signal, operationSignal]);
      check(bounded, reference);
      await options.current(bounded);
      check(bounded, reference);
      if (reference) {
        const operation = options.protocol.checkTeamAssetFile(run, reference, bounded),
          drain = physical(operation.drain);
        try {
          await operation.result;
        } finally {
          await drain;
        }
      } else {
        const view = await options.protocol.status(run, bounded);
        if (view.authority !== 'drive' || view.resources !== 'held' || view.stopRequested)
          throw new ExecutionRunError('run-authority-denied');
      }
      check(bounded, reference);
    };
    const reserve = (size: number) => {
      for (const [key, value] of cache) {
        if (used + size <= CACHE_BYTES) break;
        if (value.pins) continue;
        cache.delete(key);
        used -= value.file.byteSize;
      }
      if (used + size > CACHE_BYTES) throw new ExecutionRunError('run-capacity');
      used += size;
    };
    const ports: TeamAssetFileToolPorts = Object.freeze({
      catalog: Object.freeze({ scope: snapshot.payload.scope, files }),
      signal,
      assertCurrent: (operationSignal: AbortSignal, reference?: MemberAssetReference) =>
        pending(current(operationSignal, reference)),
      openFile(reference: MemberAssetReference, operationSignal: AbortSignal) {
        check(operationSignal, reference);
        const key = canonicalPayload(reference),
          row = files.find((file) => canonicalPayload(file.reference) === key),
          bounded = AbortSignal.any([signal, operationSignal]),
          drains: Promise<void>[] = [];
        if (!row) throw new ExecutionRunError('run-scope-mismatch');
        const result = (async () => {
          await options.current(bounded);
          check(bounded, reference);
          let value = cache.get(key);
          const cached = value;
          if (cached) cached.pins++;
          try {
            if (value) {
              // Every hit repeats the original backend check. Byte reuse cannot
              // turn a previous membership/permit decision into current access.
              const operation = options.protocol.checkTeamAssetFile(run, reference, bounded);
              drains.push(physical(operation.drain));
              await operation.result;
              check(bounded, reference);
            } else {
              reserve(row.file.byteSize);
              let retained = false;
              try {
                const operation = options.protocol.openTeamAssetFile(run, reference, bounded);
                drains.push(physical(operation.drain));
                const read = await operation.result;
                check(bounded, reference);
                const carrier = createVerifiedTeamAssetFile(read.file, read.bytes);
                // Concurrent misses may finish together. Retain one original
                // carrier and account for both in-flight reservations until here.
                value = cache.get(key);
                if (!value) {
                  value = { carrier, file: row.file, pins: 0 };
                  cache.set(key, value);
                  retained = true;
                }
              } finally {
                if (!retained) used -= row.file.byteSize;
              }
            }
            check(bounded, reference);
            if (!cached) value.pins++;
            cache.delete(key);
            cache.set(key, value);
            const selected = value;
            let released = false;
            return Object.freeze({
              file: selected.file,
              carrier: selected.carrier,
              signal: bounded,
              check() {
                check(bounded, reference);
                if (released) throw new ExecutionRunError('run-authority-denied');
              },
              release() {
                if (released) return;
                released = true;
                selected.pins--;
              },
            });
          } catch (error) {
            if (cached) cached.pins--;
            throw error;
          }
        })();
        // The result may fail before a cancelled producer physically settles.
        // Never race the actual drains against the caller's AbortSignal.
        const drain = pending(
          result.then(
            async () => {
              await Promise.all(drains);
            },
            async () => {
              await Promise.all(drains);
            },
          ),
        );
        return Object.freeze({ result, drain });
      },
    });
    states.set(run, { binding, grant, ports });
    return ports;
  }
  const fence = () => lifetime.abort();
  return {
    create,
    fence,
    async close() {
      fence();
      while (active.size) await Promise.allSettled([...active]);
      states.clear();
      if (drainFailed) throw new ExecutionRunError('run-authority-unavailable');
    },
  };
}
