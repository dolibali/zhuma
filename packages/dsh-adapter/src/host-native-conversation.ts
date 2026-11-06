import { z } from 'zod';
import { canonicalPayload } from '@zhuma/agent-core';
import type {
  SessionFollowFrame,
  SessionFollowRequest,
  SessionPage,
  SessionPageRequest,
} from '@deepseek-ai/dsh-api-session-controller/types';
import type { ExecutionRunAuthorities } from './execution-run-authority.js';
import type { MemberRequest } from './member-session.js';
import type { NativeWorkSessionService } from './native-work-session.js';
import { NativeWorkError } from './native-work-session-contract.js';
import { conversationTarget } from './host-run-reader.js';

const id = z.string().min(1).max(200);
const positive = z.number().int().positive().refine(Number.isSafeInteger);
const targetSchema = z.strictObject({
  spaceId: id,
  taskId: id,
  planId: id,
  revision: positive,
  nodeId: id,
  runId: id,
  generation: positive,
  segmentId: id,
});
const window = {
  maxMessages: positive.max(500).optional(),
  turnWindow: z.strictObject({ minMessages: positive.max(500), minTurns: positive }).optional(),
};
const address = z.strictObject({ kind: z.literal('session'), sessionId: id });
const input = z.strictObject({
  actorId: id,
  spaceId: id,
  sessionId: id,
  target: targetSchema,
  request: z.unknown(),
});
const pageRequest = z.strictObject({
  address,
  ...window,
  throughSeq: z.number().int().min(-1).refine(Number.isSafeInteger),
  beforeSeq: z.number().int().min(0).refine(Number.isSafeInteger).optional(),
});
const followRequest = z.strictObject({
  address,
  ...window,
  assistantStream: z.literal(true).optional(),
});

/** Non-Remote SDK face. Full original frames are available only after the original member Run lease. */
export interface PassiveSessionHistory {
  page(request: SessionPageRequest, signal: AbortSignal): Promise<SessionPage>;
  followReadOnly(
    request: SessionFollowRequest,
    signal: AbortSignal,
  ): AsyncIterable<SessionFollowFrame>;
}

export function createHostNativeConversation(options: {
  authorities: ExecutionRunAuthorities;
  native: Pick<NativeWorkSessionService, 'open'>;
  history(): { readonly identity: object; readonly source: PassiveSessionHistory };
  signal: AbortSignal;
  assertCurrent(): void;
}) {
  async function open(request: MemberRequest, raw: unknown, wait: AbortSignal) {
    const data = input.parse(raw);
    const {
      spaceId: _space,
      generation: _generation,
      segmentId: _segment,
      ...locator
    } = data.target;
    options.assertCurrent();
    wait.throwIfAborted();
    const owned = await options.authorities.open(request, locator, 'read');
    try {
      const grant = owned.grant;
      const signal = AbortSignal.any([wait, options.signal, grant.signal]);
      const assert = () => {
        signal.throwIfAborted();
        options.assertCurrent();
        grant.assertCurrent('history');
        if (
          data.actorId !== grant.scope.actorId ||
          data.spaceId !== grant.scope.spaceId ||
          canonicalPayload(data.target) !== canonicalPayload(conversationTarget(grant.scope)) ||
          options.native.open(grant)?.binding.nativeSessionId !== data.sessionId
        )
          throw new NativeWorkError('scope-mismatch');
      };
      assert();
      return { data, signal, assert, dispose: () => owned.dispose() };
    } catch (error) {
      owned.dispose();
      throw error;
    }
  }
  return {
    async available(request: MemberRequest, raw: unknown, wait: AbortSignal) {
      const owned = await open(request, raw, wait);
      const reading = new AbortController();
      let iterator: AsyncIterator<SessionFollowFrame> | undefined;
      try {
        const history = options.history();
        iterator = history.source
          .followReadOnly(
            {
              address: { kind: 'session', sessionId: owned.data.sessionId },
              maxMessages: 1,
            } as SessionFollowRequest,
            AbortSignal.any([owned.signal, reading.signal, AbortSignal.timeout(5000)]),
          )
          [Symbol.asyncIterator]();
        const first = await iterator.next();
        owned.assert();
        return (
          options.history().identity === history.identity &&
          !first.done &&
          first.value.type === 'snapshot' &&
          first.value.header.id === owned.data.sessionId
        );
      } catch {
        // Unsupported SDK logs keep their original task UI; revoked authority never becomes a fallback.
        owned.assert();
        return false;
      } finally {
        reading.abort();
        try {
          await iterator?.return?.();
        } finally {
          owned.dispose();
        }
      }
    },
    async page(request: MemberRequest, raw: unknown, wait: AbortSignal) {
      const owned = await open(request, raw, wait);
      try {
        const query = pageRequest.parse(owned.data.request);
        if (query.address.sessionId !== owned.data.sessionId)
          throw new NativeWorkError('scope-mismatch');
        const history = options.history();
        const page = await history.source.page(query as SessionPageRequest, owned.signal);
        owned.assert();
        if (options.history().identity !== history.identity)
          throw new NativeWorkError('unavailable');
        return page;
      } finally {
        owned.dispose();
      }
    },
    async follow(
      request: MemberRequest,
      raw: unknown,
      sink: (frame: SessionFollowFrame, signal: AbortSignal) => Promise<void>,
      wait: AbortSignal,
    ) {
      const owned = await open(request, raw, wait);
      try {
        const query = followRequest.parse(owned.data.request);
        if (query.address.sessionId !== owned.data.sessionId)
          throw new NativeWorkError('scope-mismatch');
        const history = options.history();
        for await (const frame of history.source.followReadOnly(
          query as SessionFollowRequest,
          owned.signal,
        )) {
          owned.assert();
          if (options.history().identity !== history.identity)
            throw new NativeWorkError('unavailable');
          await sink(frame, owned.signal);
          owned.assert();
        }
      } finally {
        owned.dispose();
      }
    },
  };
}
