import { SharedBackendError, type HostSharedBackend } from './host-shared-backend.js';
import type { NativeSessionAdmissionSource } from './host-session-admission.js';

export interface HostNativeChild extends NativeSessionAdmissionSource {
  /** Missing original idle metadata is unavailable, never permission to switch. */
  canSwitchBackend?: (() => boolean) | undefined;
  close(): Promise<void>;
  dispose(): Promise<void>;
}

/** Only the original opener may issue this after its failed mount really disposed. */
export class HostNativeOpenRefusal extends Error {
  constructor(cause: unknown) {
    super('Native owner opening was disposed.', { cause });
    this.name = 'HostNativeOpenRefusal';
  }
}

/** One in-process original child lifetime. This stores no business/Run/session
 * facts and never turns close/SDK idle into a readiness or drain certificate. */
export function createHostNativeOwnerLifecycle(options: {
  readonly backend: HostSharedBackend;
  openLocal(): Promise<HostNativeChild>;
  openRemote(): Promise<HostNativeChild>;
  failed(error: unknown): void;
}) {
  let child: HostNativeChild | undefined;
  let phase: 'opening' | 'ready' | 'waiting-auth' | 'transitioning' | 'failed' | 'closed' =
    'opening';
  let epoch = 0;
  let opening: Promise<void> | undefined;
  let draining: Promise<void> | undefined;
  let closed = false;
  let broken = false;
  let selecting = false;
  async function release() {
    if (draining) return draining;
    const previous = child;
    if (!previous) return;
    const work = (async () => {
      // Retain the child after a failed physical drain. A later scope cannot
      // take over while the original owner still has unresolved obligations.
      await previous.close();
      await previous.dispose();
      if (child === previous) child = undefined;
    })();
    draining = work;
    try {
      await work;
    } finally {
      if (draining === work) draining = undefined;
    }
  }
  async function openCurrent(generation: number) {
    const status = await options.backend.status();
    if (closed || generation !== epoch) return;
    if (status.origin && !(await options.backend.hasNativeAuthentication())) {
      if (!closed && generation === epoch) phase = 'waiting-auth';
      return;
    }
    if (closed || generation !== epoch) return;
    const next = await (status.origin ? options.openRemote() : options.openLocal());
    if (closed || generation !== epoch) {
      child = next;
      await release();
      return;
    }
    child = next;
    phase = 'ready';
  }
  async function mount() {
    const generation = epoch;
    const work = openCurrent(generation).catch((error: unknown) => {
      if (!(error instanceof HostNativeOpenRefusal)) broken = true;
      if (!closed && generation === epoch) phase = 'failed';
      throw error;
    });
    opening = work;
    try {
      await work;
    } finally {
      if (opening === work) opening = undefined;
    }
  }
  const unsubscribe = options.backend.onNativeAuthenticationChanged((kind) => {
    if (closed) return;
    if (
      kind === 'verified' &&
      (phase !== 'failed' || broken || child || opening || draining || selecting)
    )
      return;
    // Logout/revocation is intentionally different from an ordinary switch:
    // fence immediately and start genuine cleanup, including during an open.
    phase = 'transitioning';
    ++epoch;
    const generation = epoch;
    const priorOpening = opening;
    const cleanup = release();
    if (selecting) {
      // An auth response can race a durable backend selection. It may fence
      // the old child, but must never remount the old selection in that gap.
      void cleanup.catch((error: unknown) => {
        broken = true;
        phase = 'failed';
        options.failed(error);
      });
      return;
    }
    const work = (async () => {
      await priorOpening?.catch((error: unknown) => {
        if (!(error instanceof HostNativeOpenRefusal)) throw error;
      });
      await cleanup;
      if (closed || generation !== epoch) return;
      if (broken) {
        phase = 'failed';
        return;
      }
      if (kind === 'changed' || kind === 'verified') await mount();
      else phase = 'waiting-auth';
    })();
    void work.catch((error: unknown) => {
      if (closed || generation === epoch) phase = closed ? 'closed' : 'failed';
      options.failed(error);
    });
  });
  return {
    start: mount,
    current() {
      return phase === 'ready' && !closed ? child : undefined;
    },
    async prepare() {
      if (closed || broken || opening || draining || phase === 'transitioning')
        throw new SharedBackendError('unavailable');
      // Gate and test occur in one synchronous step, before the first await.
      const previous = phase;
      phase = 'transitioning';
      let idle = false;
      try {
        idle = !child || child.canSwitchBackend?.() === true;
      } catch {
        idle = false;
      }
      if (!idle) {
        phase = previous;
        throw new SharedBackendError('native-busy');
      }
      ++epoch;
      selecting = true;
      try {
        await release();
      } catch (error) {
        broken = true;
        selecting = false;
        phase = 'failed';
        throw error;
      }
      return {
        async committed() {
          try {
            if (closed || broken) throw new SharedBackendError('unavailable');
            await release();
            await mount();
          } finally {
            selecting = false;
          }
        },
        failed() {
          selecting = false;
          if (!closed) phase = 'failed';
        },
      };
    },
    async close() {
      if (!closed) {
        closed = true;
        phase = 'closed';
        ++epoch;
        unsubscribe();
      }
      const pending = opening,
        cleanup = release();
      try {
        await pending;
      } finally {
        await cleanup;
      }
    },
  };
}
