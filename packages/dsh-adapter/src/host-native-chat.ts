import type {
  NativeReleasedConversationAuthorities,
  OpenedNativeReleasedConversation,
} from './native-released-conversation-authority.js';
import type { NativeReleasedConversationController } from './native-work-session-conversation.js';
import { NativeWorkError } from './native-work-session-contract.js';
import type { MemberRequest } from './member-session.js';
import { canonicalPayload } from '@zhuma/agent-core';
import { conversationTarget } from './host-run-reader.js';
import { hostNativeConversationInput } from './host-native-conversation.js';

/** Host-owned send handles only. Transcripts and epochs remain with the original owners. */
export function createHostNativeChat(options: {
  authorities: NativeReleasedConversationAuthorities;
  native: NativeReleasedConversationController;
  signal: AbortSignal;
  assertCurrent(): void;
}) {
  type Owner = {
    opened: Promise<OpenedNativeReleasedConversation>;
    handle?: OpenedNativeReleasedConversation;
    activation?: Promise<unknown>;
    stop?: Promise<'pending' | 'stopped'>;
  };
  const owners = new Map<string, Owner>();
  const pending = new Set<Promise<unknown>>();
  const track = <T>(work: Promise<T>) => {
    pending.add(work);
    void work.finally(() => pending.delete(work)).catch(() => undefined);
    return work;
  };
  function active() {
    options.signal.throwIfAborted();
    options.assertCurrent();
  }
  function locator(data: ReturnType<typeof hostNativeConversationInput.parse>) {
    const { spaceId: _space, generation: _generation, segmentId: _segment, ...value } = data.target;
    return value;
  }
  async function read(request: MemberRequest, raw: unknown) {
    active();
    const data = hostNativeConversationInput.parse(raw);
    const owned = await options.authorities.openRead(request, locator(data));
    try {
      options.authorities.assertReadGrant(owned.grant);
      const view = options.native.open(owned.grant);
      if (
        data.actorId !== owned.grant.actorId ||
        data.spaceId !== owned.grant.spaceId ||
        view.binding.nativeSessionId !== data.sessionId ||
        canonicalPayload(conversationTarget(view.binding.scope)) !== canonicalPayload(data.target)
      )
        throw new NativeWorkError('scope-mismatch');
      active();
      options.authorities.assertReadGrant(owned.grant);
      return { data, owned, view };
    } catch (error) {
      owned.dispose();
      throw error;
    }
  }
  async function transition(sessionId: string, signal = options.signal) {
    signal.throwIfAborted();
    const owner = owners.get(sessionId);
    const work = (async () => {
      await owner?.activation;
      if (owner?.handle?.grant.signal.aborted)
        await options.authorities.whenSettled(owner.handle.grant);
      active();
    })();
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(new DOMException('History read cancelled', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
  async function status(request: MemberRequest, raw: unknown, signal: AbortSignal) {
    const parsed = hostNativeConversationInput.parse(raw);
    const eligibility = await options.authorities.observeSendEligibility(request, locator(parsed));
    signal.throwIfAborted();
    if (
      eligibility.eligible &&
      owners.get(parsed.sessionId)?.handle?.grant.actorId === parsed.actorId
    )
      await transition(parsed.sessionId, signal);
    const { data, owned, view } = await read(request, raw);
    try {
      options.authorities.assertReadGrant(owned.grant);
      const current = owners.get(data.sessionId)?.handle;
      let canStop = false;
      if (
        current &&
        current.grant.actorId === owned.grant.actorId &&
        !current.grant.signal.aborted
      ) {
        try {
          options.authorities.assertGrant(current.grant, 'stop');
          canStop = true;
        } catch {
          /* A visible history does not grant control of its native owner. */
        }
      }
      options.authorities.assertReadGrant(owned.grant);
      return {
        chatEpoch: owned.grant.chatEpoch,
        status: view.status,
        eligible: eligibility.eligible,
        canStop,
      };
    } finally {
      owned.dispose();
    }
  }
  async function send(request: MemberRequest, raw: unknown) {
    const { data, owned } = await read(request, raw);
    const input = data.request;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      owned.dispose();
      throw new NativeWorkError('invalid-request');
    }
    const requestId = Reflect.get(input, 'requestId'),
      text = Reflect.get(input, 'text');
    if (
      typeof requestId !== 'string' ||
      !requestId ||
      requestId.length > 200 ||
      typeof text !== 'string' ||
      !text.trim() ||
      text.length > 16_384 ||
      Object.keys(input).some((key) => !['requestId', 'text'].includes(key))
    ) {
      owned.dispose();
      throw new NativeWorkError('invalid-request');
    }
    const actor = owned.grant.actorId;
    owned.dispose();
    active();
    let owner = owners.get(data.sessionId);
    if (owner?.handle?.grant.signal.aborted) {
      await options.authorities.whenSettled(owner.handle.grant);
      active();
      owner = owners.get(data.sessionId);
    }
    if (!owner) {
      const opening = options.authorities.open(request, locator(data));
      owner = { opened: opening };
      owners.set(data.sessionId, owner);
      const entry = owner;
      void opening.then(
        (handle) => {
          entry.handle = handle;
          void options.authorities.whenSettled(handle.grant).then(
            () => {
              if (owners.get(data.sessionId) === entry) owners.delete(data.sessionId);
              handle.dispose();
            },
            () => undefined,
          );
        },
        () => {
          if (owners.get(data.sessionId) === entry) owners.delete(data.sessionId);
        },
      );
    }
    const entry = owner;
    const sending = (async () => {
      const handle = await entry.opened;
      active();
      options.authorities.assertGrant(handle.grant, 'send');
      if (handle.grant.actorId !== actor || handle.grant.origin.nativeSessionId !== data.sessionId)
        throw new NativeWorkError('scope-mismatch');
      // The native owner retains admission through HTTP cancellation and preserves the SDK request id.
      const receipt = await options.native.send(handle.grant, { requestId, text });
      options.authorities.assertGrant(handle.grant, 'read');
      if (!['received', 'claimed'].includes(receipt.status))
        throw new NativeWorkError('delivery-unknown');
      return {
        accepted: true as const,
        requestId: receipt.requestId,
        status: receipt.status,
        chatEpoch: handle.grant.chatEpoch,
      };
    })();
    entry.activation = sending;
    return track(sending);
  }
  async function stop(request: MemberRequest, raw: unknown) {
    const { data, owned } = await read(request, raw);
    const owner = owners.get(data.sessionId);
    try {
      const handle = owner && (await owner.opened);
      if (!owner || !handle || handle.grant.actorId !== owned.grant.actorId)
        throw new NativeWorkError('scope-mismatch');
      options.authorities.assertReadGrant(owned.grant);
      owner.stop ??= options.authorities.stop(handle.grant);
      return { status: await owner.stop, chatEpoch: handle.grant.chatEpoch };
    } finally {
      owned.dispose();
    }
  }
  return {
    status: (request: MemberRequest, raw: unknown, signal: AbortSignal = options.signal) =>
      track(status(request, raw, signal)),
    send: (request: MemberRequest, raw: unknown) => track(send(request, raw)),
    stop: (request: MemberRequest, raw: unknown) => track(stop(request, raw)),
    transition,
    canSwitchBackend: () => owners.size === 0 && pending.size === 0,
    async close() {
      // D closes its genuine epochs before the original native mapping domain closes.
      await options.authorities.close();
      await Promise.allSettled([...pending]);
      owners.clear();
    },
  };
}
