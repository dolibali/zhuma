import type { IdentityApi } from './api.js';
import { createMemberSessionController, type MemberSessionState } from './session.js';
import { createMemberSpaceController, type MemberSpaceState } from './spaces.js';

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
export function createMemberShell(api: IdentityApi) {
  const session = createMemberSessionController(api);
  let space: MemberSpaceController | undefined;
  let memberEpoch: number | undefined;
  let stopSession: (() => void) | undefined;
  let stopSpace: (() => void) | undefined;
  let pageActive = false;
  let pageEpoch = 0;
  let guard: { epoch: number; select: SpaceSwitch } | undefined;
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
  }
  function changed() {
    const state = session.getSnapshot();
    if (state.status !== 'authenticated') clearSpace();
    else if (state.epoch !== memberEpoch) {
      clearSpace();
      memberEpoch = state.epoch;
      const current = createMemberSpaceController(api, state.session, () =>
        session.invalidate(state.epoch),
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
      ++pageEpoch;
      publish();
    },
    setPageActive(active: boolean) {
      if (active === pageActive) return;
      pageActive = active;
      ++pageEpoch;
      guard = undefined;
      publish();
    },
    isPageCurrent(epoch: number) {
      return pageActive && pageEpoch === epoch;
    },
    registerSpaceGuard(epoch: number, select: SpaceSwitch) {
      if (!pageActive || epoch !== pageEpoch) return () => {};
      const current = { epoch, select };
      guard = current;
      return () => {
        if (guard === current) guard = undefined;
      };
    },
    requestSpace(id: string, restoreFocus?: () => void) {
      if (guard && pageActive && guard.epoch === pageEpoch) guard.select(id, restoreFocus);
      else void space?.select(id);
    },
  };
}
export type MemberShell = ReturnType<typeof createMemberShell>;
