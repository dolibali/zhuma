import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '../workbench/Button.js';
import { Modal } from '../workbench/controls.js';
import { useLeaveConfirmation } from '../workbench/useLeaveConfirmation.js';
import { NativeRunPanel } from './NativeRunPanel.js';
import { NativeReviewLauncher } from './NativeReviewWorkspace.js';
import { createNativeRunController } from './controller.js';
import type { NativeRunApi } from './api.js';
import type { NativeRunTarget } from './native-run-contract.js';
import { WorkspaceApprovalDialog } from './WorkspaceApprovalDialog.js';
import type { WorkspaceApprovalLocation } from './workspace-approvals.js';

type Props = {
  api: NativeRunApi;
  target: NativeRunTarget;
  onDirtyChange?: ((dirty: boolean) => void) | undefined;
  onClose?: (() => void) | undefined;
};
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
function Workspace({ api, target, onDirtyChange, onClose }: Props) {
  const fixedTarget = useRef(target).current;
  const [controller, setController] = useState<ReturnType<typeof createNativeRunController>>();
  const [approvalLocation, setApprovalLocation] = useState<WorkspaceApprovalLocation>();
  const navigation = useRef<AbortController>();
  useEffect(() => {
    const lifetime = new AbortController();
    navigation.current = lifetime;
    const current = createNativeRunController(api, fixedTarget);
    setController(current);
    void current.refresh().catch(() => undefined);
    return () => {
      lifetime.abort();
      current.dispose();
    };
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
    <>
      <NativeRunPanel
        target={target}
        view={state.view}
        busy={state.busy}
        error={state.error}
        reviewAction={
          api.review && run?.submission?.roundId ? (
            <NativeReviewLauncher
              api={api.review}
              target={{
                spaceId: target.spaceId,
                taskId: target.taskId,
                planId: target.planId,
                revision: target.revision,
                nodeId: target.nodeId,
                roundId: run.submission.roundId,
                artifactVersionId: run.submission.artifactVersionId,
              }}
            />
          ) : undefined
        }
        onDirtyChange={onDirtyChange}
        onClose={onClose}
        onOpenSession={
          api.openNativeSession && run?.native
            ? async () => {
                const lifetime = navigation.current;
                if (!lifetime) throw new DOMException('View changed', 'AbortError');
                await api.openNativeSession!(run, lifetime.signal);
              }
            : undefined
        }
        onManageWorkspaces={
          api.workspaceApprovals && state.view.kind === 'ready' && state.view.workspaceApprovalScope
            ? () => {
                if (state.view.kind === 'ready')
                  setApprovalLocation(state.view.workspaceApprovalScope);
              }
            : undefined
        }
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
      {api.workspaceApprovals && approvalLocation && (
        <WorkspaceApprovalDialog
          api={api.workspaceApprovals}
          location={approvalLocation}
          close={() => setApprovalLocation(undefined)}
          changed={async () => {
            await controller?.refresh();
          }}
        />
      )}
    </>
  );
}

type LauncherProps = Props & { label?: string | undefined };
export function NativeRunLauncher({ api, target, label = '使用 Agent' }: LauncherProps) {
  const identity = JSON.stringify(target);
  const generation = useRef({ api, identity, epoch: 0 });
  if (generation.current.api !== api || generation.current.identity !== identity) {
    generation.current = { api, identity, epoch: generation.current.epoch + 1 };
  }
  return <Launcher key={generation.current.epoch} api={api} target={target} label={label} />;
}
function Launcher({ api, target, label }: LauncherProps) {
  const [open, setOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const opener = useRef<HTMLButtonElement | null>(null);
  const restoreFocus = useCallback(() => {
    if (opener.current?.isConnected) opener.current.focus();
  }, []);
  const changeDirty = useCallback((dirty: boolean) => setDirty(dirty), []);
  const leave = useLeaveConfirmation();
  const close = () => leave.request(() => setOpen(false), dirty);
  return (
    <>
      {leave.dialog}
      <Button
        onClick={(event) => {
          opener.current = event.currentTarget;
          setOpen(true);
        }}
      >
        {label}
      </Button>
      {open && (
        <Modal title={target.title} variant="workspace" close={close} restoreFocus={restoreFocus}>
          <div className="zm-run-workspace-dialog">
            <NativeRunWorkspace
              api={api}
              target={target}
              onDirtyChange={changeDirty}
              onClose={close}
            />
          </div>
        </Modal>
      )}
    </>
  );
}
