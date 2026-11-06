import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from './Button.js';
import { Modal } from './controls.js';

export type LeaveGesture = 'leave' | 'confirm' | 'ignore';

/**
 * A still-mounted control must leave or open confirmation.
 * A flipped caller fence is not a reason to drop the gesture: that hid the
 * dialog and left the detail in place. Only unmount, or a navigation signal
 * that already lost to a newer one, declines without UI.
 */
export function resolveLeaveGesture(input: {
  mounted: boolean;
  superseded: boolean;
  dirty: boolean;
}): LeaveGesture {
  if (!input.mounted || input.superseded) return 'ignore';
  return input.dirty ? 'confirm' : 'leave';
}

/** Accepting the open confirmation always leaves while that dialog is mounted. */
export function resolveLeaveAcceptance(input: { mounted: boolean }): 'leave' | 'ignore' {
  return input.mounted ? 'leave' : 'ignore';
}

/** A presentation guard only. An accepted write can still finish after leaving. */
export function useLeaveConfirmation(isCurrent: () => boolean = () => true) {
  // Callers still pass a view fence. It must not veto a mounted gesture.
  void isCurrent;
  const alive = useRef(true);
  const id = useId();
  const [pending, setPending] = useState<{
    leave(): void;
    restoreFocus(): void;
    signal?: AbortSignal | undefined;
  }>();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!pending?.signal) return;
    const cancel = () => setPending((current) => (current === pending ? undefined : current));
    pending.signal.addEventListener('abort', cancel, { once: true });
    if (pending.signal.aborted) cancel();
    return () => pending.signal?.removeEventListener('abort', cancel);
  }, [pending]);
  const request = useCallback((leave: () => void, dirty: boolean, signal?: AbortSignal) => {
    const gesture = resolveLeaveGesture({
      mounted: alive.current,
      superseded: signal?.aborted === true,
      dirty,
    });
    if (gesture === 'ignore') return false;
    if (gesture === 'leave') {
      leave();
      return true;
    }
    const trigger = document.activeElement;
    setPending({
      leave,
      signal,
      restoreFocus: () => {
        if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
      },
    });
    return true;
  }, []);
  return {
    request,
    dialog: pending ? (
      <Modal
        title="离开当前页面？"
        variant="confirmation"
        descriptionId={id}
        initialFocusId={`${id}-cancel`}
        restoreFocus={pending.restoreFocus}
        close={() => setPending(undefined)}
      >
        <div className="zm-confirmation-body">
          <div className="zm-confirmation-message" id={id}>
            <p>未保存的内容和未应用的草案将被放弃。</p>
            <p className="zm-confirmation-note">已发送的操作仍可能完成。</p>
          </div>
          <div className="zm-confirmation-actions">
            <Button id={`${id}-cancel`} onClick={() => setPending(undefined)}>
              继续编辑
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (resolveLeaveAcceptance({ mounted: alive.current }) !== 'leave') return;
                const action = pending.leave;
                setPending(undefined);
                action();
              }}
            >
              放弃并离开
            </Button>
          </div>
        </div>
      </Modal>
    ) : null,
  };
}
