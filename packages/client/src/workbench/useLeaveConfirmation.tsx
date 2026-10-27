import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from './Button.js';
import { Modal } from './controls.js';

/** A presentation guard only. An accepted write can still finish after leaving. */
export function useLeaveConfirmation(isCurrent: () => boolean = () => true) {
  const current = useRef(isCurrent);
  current.current = isCurrent;
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
    if (!alive.current || !current.current() || signal?.aborted) return;
    if (!dirty) {
      leave();
      return;
    }
    const trigger = document.activeElement;
    setPending({
      leave,
      signal,
      restoreFocus: () => {
        if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
      },
    });
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
                if (!alive.current || !current.current() || pending.signal?.aborted) return;
                setPending(undefined);
                pending.leave();
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
