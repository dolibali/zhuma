import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '../workbench/Button.js';
import { Modal } from '../workbench/controls.js';
import { NativeRunPanel } from './NativeRunPanel.js';
import { createNativeRunController } from './controller.js';
import type { NativeRunApi } from './api.js';
import type { NativeRunTarget } from './native-run-contract.js';

type Props = { api: NativeRunApi; target: NativeRunTarget };
const empty = { view: { kind: 'loading' as const }, busy: undefined, error: undefined };
const subscribeNone = () => () => {};
const getEmpty = () => empty;

/** API identity belongs to one trusted member/controller epoch, even for identical target ids. */
export function NativeRunWorkspace(props: Props) {
  const identity = JSON.stringify(props.target);
  const scope = useRef({ api: props.api, identity, epoch: 0 });
  if (scope.current.api !== props.api || scope.current.identity !== identity)
    scope.current = { api: props.api, identity, epoch: scope.current.epoch + 1 };
  return <Workspace key={scope.current.epoch} {...props} />;
}
function Workspace({ api, target }: Props) {
  const fixedTarget = useRef(target).current;
  const [controller, setController] = useState<ReturnType<typeof createNativeRunController>>();
  useEffect(() => {
    const current = createNativeRunController(api, fixedTarget);
    setController(current);
    void current.refresh().catch(() => undefined);
    return () => current.dispose();
  }, [api, fixedTarget]);
  const state = useSyncExternalStore(
    controller?.subscribe ?? subscribeNone,
    controller?.getSnapshot ?? getEmpty,
    controller?.getSnapshot ?? getEmpty,
  );
  const run = state.view.kind === 'ready' ? state.view.run : null;
  useEffect(() => {
    if (!controller || !run || run.resources !== 'held' || state.view.kind !== 'ready') return;
    // Passive progress only: does not rediscover models, connect or drive an Agent.
    const timer = setInterval(() => {
      if (!document.hidden) void controller.refresh(false).catch(() => undefined);
    }, 2500);
    return () => clearInterval(timer);
  }, [controller, run?.runId, run?.resources, state.view.kind]);
  return (
    <NativeRunPanel
      target={target}
      view={state.view}
      busy={state.busy}
      error={state.error}
      onSelectionChange={(selection) => controller?.select(selection)}
      onStart={async (selection) => {
        if (!controller) throw Error('Loading');
        await controller.start(selection);
      }}
      onSend={async (text, mode) => {
        if (!controller) throw Error('Loading');
        await controller.send(text, mode);
      }}
      onStop={async () => {
        if (!controller) throw Error('Loading');
        await controller.stop();
      }}
      onRefresh={async () => {
        if (!controller) throw Error('Loading');
        await controller.refresh();
      }}
      onLoadEarlier={async () => {
        /* SDK history is forward-only; no earlier-page affordance. */
      }}
    />
  );
}

export function NativeRunLauncher({ api, target }: Props) {
  const [open, setOpen] = useState(false);
  const identity = JSON.stringify(target);
  const generation = useRef({ api, identity });
  if (generation.current.api !== api || generation.current.identity !== identity) {
    generation.current = { api, identity };
    if (open) setOpen(false);
  }
  return (
    <>
      <Button onClick={() => setOpen(true)}>使用 Agent</Button>
      {open && (
        <Modal title="Agent 工作区" close={() => setOpen(false)}>
          <div className="zm-run-workspace-dialog">
            <NativeRunWorkspace api={api} target={target} />
          </div>
        </Modal>
      )}
    </>
  );
}
