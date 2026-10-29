import type { IdentityApi } from './api.js';
import { createMemberSessionController, type MemberSessionState } from './session.js';
import { createMemberSpaceController, type MemberSpaceState } from './spaces.js';
import { createSpacePreferenceStore, type SpacePreferenceStore } from './space-preferences.js';

export type MemberSessionController = ReturnType<typeof createMemberSessionController>;
export type MemberSpaceController = ReturnType<typeof createMemberSpaceController>;
/** Presentation callback only; cancellation returns focus to the initiating control. */
export type SpaceSwitch = (id: string, restoreFocus?: () => void) => void;
export interface MemberShellSnapshot {
  readonly session: MemberSessionState;
  readonly space: MemberSpaceState | undefined;
  readonly pageActive: boolean;
  readonly pageEpoch: number;
}

/** One plugin-owned UI projection. No credentials, business data or authorization cache. */
export function createMemberShell(
  api: IdentityApi,
  preferences: SpacePreferenceStore = createSpacePreferenceStore(),
) {
  const session = createMemberSessionController(api);
  let space: MemberSpaceController | undefined;
  let memberEpoch: number | undefined;
  let stopSession: (() => void) | undefined;
  let stopSpace: (() => void) | undefined;
  let pageActive = false;
  let pageEpoch = 0;
  let pageKey: string | undefined;
  let guard: { epoch: number; select: SpaceSwitch } | undefined;
  let leaveGuard:
    { epoch: number; leave: (proceed: () => void, signal?: AbortSignal) => void } | undefined;
  const listeners = new Set<() => void>();
  let snapshot: MemberShellSnapshot = {
    session: session.getSnapshot(),
    space: undefined,
    pageActive,
    pageEpoch,
  };
  function publish() {
    snapshot = {
      session: session.getSnapshot(),
      space: space?.getSnapshot(),
      pageActive,
      pageEpoch,
    };
    listeners.forEach((listener) => listener());
  }
  function clearSpace() {
    stopSpace?.();
    stopSpace = undefined;
    space?.dispose();
    space = undefined;
    memberEpoch = undefined;
    guard = undefined;
    leaveGuard = undefined;
  }
  function changed() {
    const state = session.getSnapshot();
    if (state.status !== 'authenticated') clearSpace();
    else if (state.epoch !== memberEpoch) {
      clearSpace();
      memberEpoch = state.epoch;
      const accountId = state.session.accountId;
      const current = createMemberSpaceController(
        api,
        state.session,
        () => session.invalidate(state.epoch),
        {
          preferredSpaceId: preferences.read(accountId),
          onConfirmedSelect: (id) => preferences.save(accountId, id),
          onUnavailable: (id) => preferences.clearIfMatches(accountId, id),
        },
      );
      space = current;
      stopSpace = current.subscribe(publish);
      publish();
      void current.refresh();
      return;
    }
    publish();
  }
  return {
    api,
    session,
    get space() {
      return space;
    },
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Only the plugin owner starts/stops; footer and main merely subscribe. */
    start() {
      if (stopSession) return;
      stopSession = session.subscribe(changed);
      changed();
      void session.restore();
    },
    stop() {
      stopSession?.();
      stopSession = undefined;
      clearSpace();
      session.dispose();
      pageActive = false;
      pageKey = undefined;
      ++pageEpoch;
      publish();
    },
    setPageActive(active: boolean, key?: string) {
      const nextKey = active ? key : undefined;
      if (active === pageActive && nextKey === pageKey) return;
      pageActive = active;
      pageKey = nextKey;
      ++pageEpoch;
      guard = undefined;
      leaveGuard = undefined;
      publish();
    },
    isPageCurrent(epoch: number, expectedKey?: string) {
      return (
        pageActive && pageEpoch === epoch && (expectedKey === undefined || pageKey === expectedKey)
      );
    },
    registerSpaceGuard(epoch: number, select: SpaceSwitch, expectedKey?: string) {
      if (
        !pageActive ||
        epoch !== pageEpoch ||
        (expectedKey !== undefined && pageKey !== expectedKey)
      )
        return () => {};
      const current = { epoch, select };
      guard = current;
      return () => {
        if (guard === current) guard = undefined;
      };
    },
    registerLeaveGuard(
      epoch: number,
      leave: (proceed: () => void, signal?: AbortSignal) => void,
      expectedKey?: string,
    ) {
      if (
        !pageActive ||
        epoch !== pageEpoch ||
        (expectedKey !== undefined && pageKey !== expectedKey)
      )
        return () => {};
      const current = { epoch, leave };
      leaveGuard = current;
      return () => {
        if (leaveGuard === current) leaveGuard = undefined;
      };
    },
    requestLeave(proceed: () => void, signal?: AbortSignal) {
      if (signal?.aborted) return;
      if (leaveGuard && pageActive && leaveGuard.epoch === pageEpoch) {
        const epoch = pageEpoch;
        const member = memberEpoch;
        leaveGuard.leave(() => {
          if (!signal?.aborted && pageActive && epoch === pageEpoch && member === memberEpoch)
            proceed();
        }, signal);
      } else proceed();
    },
    requestSpace(id: string, restoreFocus?: () => void, expectedMemberEpoch?: number) {
      const current = session.getSnapshot();
      // A delayed menu event must not apply the former account's choice to
      // the newly mounted member controller, even when the page is unchanged.
      if (
        current.status !== 'authenticated' ||
        (expectedMemberEpoch !== undefined && current.epoch !== expectedMemberEpoch)
      )
        return;
      if (guard && pageActive && guard.epoch === pageEpoch) guard.select(id, restoreFocus);
      else void space?.select(id);
    },
  };
}
export type MemberShell = ReturnType<typeof createMemberShell>;
