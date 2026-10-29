import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Button } from '../workbench/Button.js';
import { SingleSelect } from '../workbench/SingleSelect.js';
import { Modal } from '../workbench/controls.js';
import { executionErrorMessage } from '../execution/ExecutionApi.js';
import { useExecutionCommand } from '../execution/interaction.js';
import {
  workflowPublishRanges,
  type WorkflowApi,
  type WorkflowOptions,
  type WorkflowTarget,
  type WorkflowView,
  type WorkflowWorkspace,
} from './api.js';
import { WorkspaceApprovalDialog } from '../run/WorkspaceApprovalDialog.js';
import { WorkspacePublishRanges } from '../run/WorkspacePublishRanges.js';
import type {
  WorkspaceApprovalApi,
  WorkspaceApprovalLocation,
  WorkspacePublishRange,
} from '../run/workspace-approvals.js';

type Props = {
  api: WorkflowApi;
  target: WorkflowTarget;
  onViewChange?: ((view: WorkflowView) => void) | undefined;
  nodeLabels?: Readonly<Record<string, string>>;
  openModelSettings?: (() => void) | undefined;
  workspaceApprovals?:
    { api: WorkspaceApprovalApi; location: WorkspaceApprovalLocation } | undefined;
};
const labels: Record<WorkflowView['state'], string> = {
  inactive: '尚未运行',
  running: '运行中',
  waiting: '等待工作就绪',
  stopping: '正在停止',
  paused: '已停止',
  completed: '已完成',
  'requires-resume': '等待继续',
};
const invalidWorkspaceMessage = '所选工作目录已不可用，请重新选择目录，或选择“仅处理任务资料”。';
/** Commands belong to the original member API and exact plan, including same-id re-login. */
export function WorkflowControls(props: Props) {
  const identity = JSON.stringify(props.target);
  const lifetime = useRef({ api: props.api, identity, epoch: 0 });
  if (lifetime.current.api !== props.api || lifetime.current.identity !== identity)
    lifetime.current = { api: props.api, identity, epoch: lifetime.current.epoch + 1 };
  return <Controls key={lifetime.current.epoch} {...props} />;
}
function Controls({
  api,
  target,
  onViewChange,
  workspaceApprovals,
  openModelSettings,
  nodeLabels,
}: Props) {
  const directoryId = useId(),
    manageId = useId(),
    runTriggerId = useId(),
    liveManageId = useId(),
    workspaceErrorId = useId();
  const returnToDirectory = useRef(false);
  const returnToRun = useRef(false);
  const returnToLiveManage = useRef(false);
  const fixedTarget = useRef(target).current;
  const changed = useRef(onViewChange);
  changed.current = onViewChange;
  const [view, setView] = useState<WorkflowView>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open && returnToRun.current) {
      returnToRun.current = false;
      document.getElementById(runTriggerId)?.focus();
    }
  }, [open, runTriggerId]);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  useEffect(() => {
    if (!workspaceOpen && returnToLiveManage.current) {
      returnToLiveManage.current = false;
      (document.getElementById(liveManageId) ?? document.getElementById(runTriggerId))?.focus();
    }
  }, [workspaceOpen, liveManageId, runTriggerId]);
  const [choices, setChoices] = useState<WorkflowOptions>();
  const [modelId, setModelId] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [publish, setPublish] = useState<WorkspacePublishRange[]>([]);
  const [editingWorkspace, setEditingWorkspace] = useState(false);
  const [concurrent, setConcurrent] = useState(1);
  const [automaticRevisions, setAutomaticRevisions] = useState(0);
  const reader = useRef<AbortController | undefined>(undefined);
  const alive = useRef(false);
  const command = useExecutionCommand();
  const apply = useCallback((next: WorkflowView) => {
    setView(next);
    changed.current?.(next);
  }, []);
  const refresh = useCallback(
    async (settings = false) => {
      if (!alive.current) return;
      reader.current?.abort();
      const request = new AbortController();
      reader.current = request;
      const current = () => alive.current && reader.current === request && !request.signal.aborted;
      setLoading(true);
      setError('');
      try {
        if (settings) {
          const next = await api.options(fixedTarget, request.signal);
          if (!current()) return;
          setChoices(next);
          apply(next);
        } else {
          const next = await api.read(fixedTarget, request.signal);
          if (current()) apply(next);
        }
      } catch (caught) {
        if (current()) setError(executionErrorMessage(caught));
      } finally {
        if (current()) setLoading(false);
      }
    },
    [api, fixedTarget, apply],
  );
  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
      reader.current?.abort();
    };
  }, [refresh]);
  // This is a passive fact read, never an implicit start or resume on refresh.
  useEffect(() => {
    if (
      !view ||
      open ||
      command.pending ||
      !['running', 'waiting', 'stopping'].includes(view.state)
    )
      return;
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 2500);
    return () => clearInterval(timer);
  }, [view?.state, refresh, open, command.pending]);
  function prepare() {
    setOpen(true);
    setEditingWorkspace(false);
    returnToRun.current = false;
    returnToDirectory.current = false;
    if (!choices) {
      setModelId('');
      setWorkspaceId('');
      setPublish([]);
      setConcurrent(1);
      setAutomaticRevisions(0);
    }
    command.setError('');
    void refresh(true);
  }
  function commit() {
    if (!canCommit) {
      if (workspaceUnavailable && (!view?.intent || editingWorkspace))
        command.setError(invalidWorkspaceMessage);
      return;
    }
    if (!choices || !view || loading) return;
    reader.current?.abort();
    const accept = (next: WorkflowView) => {
      apply(next);
      setOpen(false);
    };
    if (view.intent) {
      const input = {
        ...fixedTarget,
        intentId: view.intent.intentId,
        generation: view.intent.generation,
        expectedVersion: view.intent.version,
        ...(workspaceChanged ? { workspace: draftWorkspace } : {}),
      };
      void command.run(
        { mode: 'resume', ...input },
        (requestId, signal) => api.resume({ ...input, requestId }, signal),
        accept,
      );
    } else if (choices.models.kind === 'ready') {
      const model = choices.models.items.find((item) => item.id === modelId)?.value;
      const workspace = workspaceId
        ? choices.workspaces.find((item) => item.id === workspaceId)
        : undefined;
      if (!model) return;
      if (workspaceId && !workspace) {
        command.setError(invalidWorkspaceMessage);
        return;
      }
      const input = {
        ...fixedTarget,
        model,
        workspace: draftWorkspace,
        concurrent,
        ...(choices.automaticReview ? { automaticRevisions } : {}),
      };
      void command.run(
        { mode: 'start', ...input },
        (requestId, signal) => api.start({ ...input, requestId }, signal),
        accept,
      );
    }
  }
  function stop() {
    if (!view?.intent) return;
    reader.current?.abort();
    setLoading(false);
    const input = {
      ...fixedTarget,
      intentId: view.intent.intentId,
      generation: view.intent.generation,
    };
    void command.run(
      { mode: 'stop', ...input },
      (requestId, signal) => api.stop({ ...input, requestId }, signal),
      apply,
    );
  }
  const recovering = view?.state === 'stopping';
  const canResume = recovering || view?.state === 'paused' || view?.state === 'requires-resume';
  const resumeLabel = recovering ? '恢复工作流' : '继续工作流';
  const canStart =
    view?.state === 'inactive' &&
    (view.controlledNodeCount === undefined
      ? view.expertNodeCount > 0 ||
        (view.expertReviewRequired === true && view.automaticReview !== false)
      : view.controlledNodeCount > 0 ||
        (view.automaticReview === true && (view.controlledReviewNodeCount ?? 0) > 0));
  const selected =
    choices?.models.kind === 'ready' && choices.models.items.some((item) => item.id === modelId);
  const workspaceUnavailable =
    !!choices && !!workspaceId && !choices.workspaces.some((item) => item.id === workspaceId);
  const savedModel = view?.selection?.model;
  const frozenWorkspace = view?.selection?.workspace;
  const perRunPublication =
    choices?.workspaces.find((item) => item.id === workspaceId)?.publication === 'per-run';
  let publicationValid = true;
  try {
    if (perRunPublication) workflowPublishRanges(publish);
  } catch {
    publicationValid = false;
  }
  const draftWorkspace: WorkflowWorkspace = workspaceId
    ? {
        kind: 'local',
        id: workspaceId,
        ...(perRunPublication && publish.length ? { publish } : {}),
      }
    : { kind: 'text-only' };
  const normalizedWorkspace = (value: WorkflowWorkspace | { kind: 'unavailable' } | undefined) =>
    value?.kind === 'local' ? { ...value, publish: value.publish ?? [] } : value;
  const workspaceChanged =
    editingWorkspace &&
    JSON.stringify(normalizedWorkspace(draftWorkspace)) !==
      JSON.stringify(normalizedWorkspace(frozenWorkspace));
  const memberWorkspace =
    choices?.controlledNodeCount !== undefined ||
    choices?.workspaces.some((item) => item.publication === 'per-run');
  const modelPresent =
    savedModel &&
    choices?.models.kind === 'ready' &&
    choices.models.items.some(
      (item) =>
        item.value.provider === savedModel.provider && item.value.model === savedModel.model,
    );
  const canCommit =
    !!choices &&
    !loading &&
    !command.pending &&
    (view?.intent
      ? canResume &&
        !!modelPresent &&
        (editingWorkspace
          ? !workspaceUnavailable && publicationValid
          : frozenWorkspace?.kind !== 'unavailable')
      : canStart && !!selected && !workspaceUnavailable && publicationValid);
  function workspaceFields() {
    return (
      <>
        <div className="zm-field">
          <div className="zm-workflow-field-heading">
            <label htmlFor={directoryId}>工作目录</label>
            {workspaceApprovals && (
              <Button
                id={manageId}
                variant="quiet"
                disabled={command.pending || loading}
                onClick={() => {
                  returnToDirectory.current = true;
                  setWorkspaceOpen(true);
                }}
              >
                管理授权
              </Button>
            )}
          </div>
          <SingleSelect
            id={directoryId}
            label="工作目录"
            aria-invalid={workspaceUnavailable || undefined}
            aria-describedby={workspaceUnavailable ? workspaceErrorId : undefined}
            value={workspaceId}
            disabled={command.pending}
            onValueChange={(value) => {
              if (value !== workspaceId) setPublish([]);
              setWorkspaceId(value);
              command.setError('');
            }}
            options={[
              ...(workspaceUnavailable
                ? [
                    {
                      value: workspaceId,
                      label: '所选工作目录已失效',
                      disabled: true,
                    },
                  ]
                : []),
              { value: '', label: '仅处理任务资料' },
              ...(choices?.workspaces ?? []).map((item) => ({
                value: item.id,
                label: `${item.label} · ${item.access === 'write' ? '读写' : '只读'}${item.publish ? ' · 可发布文件' : ''}`,
              })),
            ]}
          />
          {workspaceUnavailable && (
            <p id={workspaceErrorId} className="zm-error" role="alert">
              {invalidWorkspaceMessage}
            </p>
          )}
        </div>
        {perRunPublication && (
          <section className="zm-field" aria-label="文件交付范围">
            <strong>文件交付范围</strong>
            <WorkspacePublishRanges
              ranges={publish}
              disabled={command.pending}
              valid={publicationValid}
              onChange={setPublish}
              defaultKind="directory"
            />
          </section>
        )}
      </>
    );
  }
  return (
    <div className="zm-workflow-controls" aria-label="工作流执行">
      {view && (
        <span className="zm-workflow-state" role="status">
          自动执行：{labels[view.state]}
          {view.activeRunCount ? ` · ${view.activeRunCount} 个 Agent` : ''}
        </span>
      )}
      {view?.revisions?.some((row) => row.used > 0) && (
        <details className="zm-workflow-revisions">
          <summary>
            已发起自动返工 {view.revisions.reduce((sum, row) => sum + row.used, 0)} 次
          </summary>
          <ul>
            {view.revisions
              .filter((row) => row.used > 0)
              .map((row) => (
                <li key={row.nodeId}>
                  {nodeLabels?.[row.nodeId] ?? '工作节点'}：{row.used} / {row.limit} 次
                </li>
              ))}
          </ul>
        </details>
      )}
      {(canStart || canResume) && (
        <Button
          id={runTriggerId}
          variant="primary"
          disabled={loading || command.pending}
          onClick={prepare}
        >
          {canResume ? resumeLabel : '运行工作流'}
        </Button>
      )}
      {view && ['running', 'waiting'].includes(view.state) && (
        <Button
          disabled={command.pending}
          busy={command.pending}
          busyLabel="正在停止…"
          onClick={stop}
        >
          停止工作流
        </Button>
      )}
      {workspaceApprovals && view && ['running', 'stopping'].includes(view.state) && !open && (
        <Button
          id={liveManageId}
          variant="quiet"
          onClick={() => {
            returnToLiveManage.current = true;
            setWorkspaceOpen(true);
          }}
        >
          管理目录授权
        </Button>
      )}
      <Button variant="quiet" disabled={loading || command.pending} onClick={() => void refresh()}>
        {loading ? '正在读取…' : '刷新状态'}
      </Button>
      {(error || command.error) && !open && (
        <span className="zm-error" role="alert">
          {error || command.error}
        </span>
      )}
      {view?.attention && !open && (
        <span role="status" className="zm-muted">
          {view.attention}
        </span>
      )}
      {open && !workspaceOpen && (
        <Modal
          title={view?.intent ? resumeLabel : '运行工作流'}
          {...(returnToDirectory.current ? { initialFocusId: manageId } : {})}
          close={() => {
            if (!command.pending) {
              returnToRun.current = true;
              setOpen(false);
            }
          }}
        >
          <form
            className="zm-workflow-settings"
            onSubmit={(event) => {
              event.preventDefault();
              commit();
            }}
          >
            <p className="zm-muted">
              {view?.controlledNodeCount === undefined
                ? 'Agent 按依赖执行，人工节点进入负责人的待办。'
                : 'Agent 接续处理你负责的节点；其他成员从各自待办开始。'}
            </p>
            {view?.automaticReview === false && view.expertReviewRequired && (
              <p className="zm-muted">专家评审需在待办中手动启动。</p>
            )}
            {loading && !choices ? (
              <p role="status">正在读取可用模型和工作区…</p>
            ) : (
              choices && (
                <>
                  {view?.intent && view.selection ? (
                    <>
                      <div className="zm-workflow-frozen">
                        <span>模型</span>
                        <strong>
                          {view.selection.model.provider} / {view.selection.model.model}
                        </strong>
                        <span>工作区</span>
                        <strong>
                          {frozenWorkspace?.kind === 'local'
                            ? (choices.workspaces.find((item) => item.id === frozenWorkspace.id)
                                ?.label ?? '原工作区')
                            : frozenWorkspace?.kind === 'unavailable'
                              ? '原工作区不可用'
                              : '仅处理任务资料'}
                        </strong>
                        <span>并行数量</span>
                        <strong>{view.intent.concurrent}</strong>
                        {view.intent.automaticRevisions !== undefined && (
                          <>
                            <span>自动返工上限</span>
                            <strong>{view.intent.automaticRevisions} 轮（继续运行不重置）</strong>
                          </>
                        )}
                        {memberWorkspace && frozenWorkspace?.kind === 'local' && (
                          <>
                            <span>文件交付范围</span>
                            <strong>
                              {frozenWorkspace.publish?.map((range) => range.path).join('、') ||
                                '未授权'}
                            </strong>
                          </>
                        )}
                        {!modelPresent && (
                          <p className="zm-error">原模型当前不可用，请先恢复模型连接。</p>
                        )}
                      </div>
                      {memberWorkspace && !recovering && !editingWorkspace && (
                        <Button
                          variant="quiet"
                          disabled={command.pending || !canResume}
                          onClick={() => {
                            setWorkspaceId(
                              frozenWorkspace?.kind === 'local' ? frozenWorkspace.id : '',
                            );
                            setPublish(
                              frozenWorkspace?.kind === 'local'
                                ? (frozenWorkspace.publish ?? []).map((range) => ({ ...range }))
                                : [],
                            );
                            setEditingWorkspace(true);
                            command.setError('');
                          }}
                        >
                          修改工作区与文件交付授权
                        </Button>
                      )}
                      {editingWorkspace && (
                        <>
                          {workspaceFields()}
                          <Button
                            variant="quiet"
                            disabled={command.pending}
                            onClick={() => setEditingWorkspace(false)}
                          >
                            取消修改
                          </Button>
                        </>
                      )}
                    </>
                  ) : (
                    <>
                      <label className="zm-field">
                        模型
                        <SingleSelect
                          label="模型"
                          value={modelId}
                          disabled={
                            command.pending ||
                            choices.models.kind !== 'ready' ||
                            !choices.models.items.length
                          }
                          onValueChange={setModelId}
                          options={[
                            {
                              value: '',
                              label:
                                choices.models.kind === 'ready' && !choices.models.items.length
                                  ? '暂无可用模型'
                                  : '选择模型',
                            },
                            ...(choices.models.kind === 'ready'
                              ? choices.models.items.map((item) => ({
                                  value: item.id,
                                  label: item.label,
                                }))
                              : []),
                          ]}
                        />
                      </label>
                      {choices.automaticReview && (
                        <label className="zm-field">
                          评审退回后自动返工
                          <SingleSelect
                            label="评审退回后自动返工"
                            value={String(automaticRevisions)}
                            disabled={command.pending}
                            onValueChange={(value) => setAutomaticRevisions(Number(value))}
                            options={[
                              { value: '0', label: '不自动返工' },
                              { value: '1', label: '最多 1 轮' },
                              { value: '2', label: '最多 2 轮' },
                            ]}
                          />
                        </label>
                      )}
                      {choices.models.kind === 'unavailable' && (
                        <p className="zm-error">{choices.models.message}</p>
                      )}
                      {(choices.models.kind === 'unavailable' || !choices.models.items.length) && (
                        <div className="zm-workflow-model-empty" role="status">
                          <span>先在设置中配置模型，再刷新选项。</span>
                          {openModelSettings && (
                            <Button
                              variant="quiet"
                              onClick={() => {
                                try {
                                  flushSync(() => setOpen(false));
                                  openModelSettings();
                                } catch (caught) {
                                  setOpen(true);
                                  setError(executionErrorMessage(caught));
                                }
                              }}
                            >
                              打开设置
                            </Button>
                          )}
                        </div>
                      )}
                      {workspaceFields()}
                      <label className="zm-field">
                        同时运行的 Agent
                        <SingleSelect
                          label="同时运行的 Agent"
                          value={String(concurrent)}
                          disabled={command.pending}
                          onValueChange={(value) => setConcurrent(Number(value))}
                          options={[1, 2, 3, 4]
                            .filter((value) => value <= (choices.maxConcurrent ?? 4))
                            .map((value) => ({
                              value: String(value),
                              label: String(value),
                            }))}
                        />
                      </label>
                    </>
                  )}
                </>
              )
            )}
            {(error || command.error) && (
              <p className="zm-error" role="alert">
                {error || command.error}
              </p>
            )}
            <footer>
              <Button disabled={command.pending} onClick={() => setOpen(false)}>
                取消
              </Button>
              <Button
                variant="quiet"
                disabled={loading || command.pending}
                onClick={() => void refresh(true)}
              >
                刷新选项
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={!canCommit}
                busy={command.pending}
                busyLabel="正在确认…"
              >
                {view?.intent ? (workspaceChanged ? '确认授权并继续' : resumeLabel) : '确认运行'}
              </Button>
            </footer>
          </form>
        </Modal>
      )}
      {workspaceOpen && workspaceApprovals && (
        <WorkspaceApprovalDialog
          api={workspaceApprovals.api}
          location={workspaceApprovals.location}
          close={() => setWorkspaceOpen(false)}
          returnLabel={open ? '返回运行设置' : '返回工作流'}
          changed={() => refresh(open)}
        />
      )}
    </div>
  );
}
