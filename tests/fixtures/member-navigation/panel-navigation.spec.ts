/** Copied into the fixed, fully patched official ui-layout test directory. No browser is driven. */
import { describe, expect, it, vi } from 'vitest';
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store';
import { LayoutController } from '../src/client/service.ts';
import type { MainPanelId, PanelActions, PanelSelectionGuard } from '../src/client/service.ts';

const team = 'zhuma-workbench' as MainPanelId;
const work = 'zhuma-my-work' as MainPanelId;
function fixture() {
  const selectPanel = vi.fn();
  const actions: PanelActions = {
    selectPanel,
    retainMainPanels: vi.fn(),
    setSidebar: vi.fn(),
    toggleSidebar: vi.fn(),
    setViewportWidth: vi.fn(),
    setRightbar: vi.fn(),
    openRightbar: vi.fn(),
    closeRightbar: vi.fn(),
  };
  const registered = new Set([team, work]);
  const layout = new LayoutController(
    actions,
    (id) => registered.has(id),
    createSnapshotStore({ activePanelId: team }),
  );
  let pending: { target: MainPanelId | null; proceed(): void; signal: AbortSignal } | undefined;
  const guard: PanelSelectionGuard = (target, proceed, signal) => {
    pending = { target, proceed, signal };
  };
  return {
    layout,
    registered,
    selectPanel,
    guard,
    pending: () => {
      expect(pending).toBeDefined();
      return pending!;
    },
  };
}

describe('patched official panel navigation', () => {
  it('defers the actual selection until confirmation and proceeds once', () => {
    const f = fixture();
    f.layout.registerPanelGuard(f.guard);
    f.layout.selectPanel(work);
    expect(f.selectPanel).not.toHaveBeenCalled();
    expect(f.pending().target).toBe(work);
    expect(f.pending().signal.aborted).toBe(false);
    f.pending().proceed();
    f.pending().proceed();
    expect(f.selectPanel).toHaveBeenCalledExactlyOnceWith(work);
  });
  it('a subsequent selection invalidates the old confirmation', () => {
    const f = fixture();
    f.layout.registerPanelGuard(f.guard);
    f.layout.selectPanel(work);
    const old = f.pending();
    f.layout.selectPanel(team);
    expect(old.signal.aborted).toBe(true);
    old.proceed();
    expect(f.selectPanel).not.toHaveBeenCalled();
    f.pending().proceed();
    expect(f.selectPanel).toHaveBeenCalledExactlyOnceWith(team);
  });
  it('New Session and workspace navigation cannot skip the guard for the Conversation', () => {
    const f = fixture();
    f.layout.registerPanelGuard(f.guard);
    f.layout.selectPanel(null);
    const old = f.pending();
    expect(f.selectPanel).not.toHaveBeenCalled();
    // Workspace navigation supersedes a prior modal before eventually selecting null.
    f.layout.beginNavigation();
    expect(old.signal.aborted).toBe(true);
    old.proceed();
    f.layout.selectPanel(null);
    expect(f.selectPanel).not.toHaveBeenCalled();
    f.pending().proceed();
    expect(f.selectPanel).toHaveBeenCalledExactlyOnceWith(null);
  });
  it('a removed deferred target cannot replace the current editor', () => {
    const f = fixture();
    f.layout.registerPanelGuard(f.guard);
    f.layout.selectPanel(work);
    f.registered.delete(work);
    f.pending().proceed();
    expect(f.selectPanel).not.toHaveBeenCalled();
    expect(() => f.layout.selectPanel(work)).toThrow('not registered');
  });
  it('removing the guard and disposing layout invalidate old continuations', () => {
    const f = fixture();
    const remove = f.layout.registerPanelGuard(f.guard);
    f.layout.selectPanel(work);
    const old = f.pending();
    remove();
    remove();
    expect(old.signal.aborted).toBe(true);
    old.proceed();
    expect(f.selectPanel).not.toHaveBeenCalled();
    f.layout.selectPanel(work);
    expect(f.selectPanel).toHaveBeenCalledExactlyOnceWith(work);
    f.layout.registerPanelGuard(f.guard);
    f.layout.selectPanel(null);
    const closing = f.pending();
    f.layout.dispose();
    closing.proceed();
    expect(closing.signal.aborted).toBe(true);
    expect(f.selectPanel).toHaveBeenCalledTimes(1);
    expect(() => f.layout.registerPanelGuard(f.guard)).toThrow('disposed');
  });
  it('cancellation or an exception never commits even after synchronous proceed', () => {
    for (const failAfterProceed of [false, true]) {
      const f = fixture();
      f.layout.registerPanelGuard((_target, proceed) => {
        if (failAfterProceed) {
          proceed();
          throw Error('synthetic guard failure');
        }
      });
      f.layout.selectPanel(work);
      expect(f.selectPanel).not.toHaveBeenCalled();
    }
  });
  it('all guards must allow the same navigation and synchronous duplicates do not skip a guard', () => {
    const f = fixture();
    const first = vi.fn<PanelSelectionGuard>((_target, proceed) => {
      proceed();
      proceed();
    });
    f.layout.registerPanelGuard(first);
    f.layout.registerPanelGuard(f.guard);
    f.layout.selectPanel(work);
    expect(first).toHaveBeenCalledTimes(1);
    expect(f.selectPanel).not.toHaveBeenCalled();
    f.pending().proceed();
    expect(f.selectPanel).toHaveBeenCalledExactlyOnceWith(work);
  });
});
