import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button } from '../workbench/Button.js';
import { SingleSelect } from '../workbench/SingleSelect.js';
import { ControlIcon } from '../workbench/ControlIcon.js';
import { workspacePublishRanges, type WorkspacePublishRange } from './workspace-approvals.js';
import { WorkspacePublishRanges } from './WorkspacePublishRanges.js';
import { useUnsavedChanges } from '../workbench/UnsavedChanges.js';
import type {
  NativeRunAction,
  NativeRunMessage,
  NativeRunPanelProps,
  NativeRunPanelView,
  NativeRunSelection,
  NativeRunSendMode,
  NativeRunSummary,
} from './native-run-contract.js';

type ReadyView = Extract<NativeRunPanelView, { kind: 'ready' }>;
type Operation = NonNullable<NativeRunPanelProps['busy']>;
const TEXT_LIMIT = 16_384;
function validPublication(ranges: unknown) {
  try {
    workspacePublishRanges(ranges);
    return true;
  } catch {
    return false;
  }
}
const modes: readonly NativeRunSendMode[] = ['followup', 'steer', 'queue'];
const modeLabels = { followup: '发送消息', steer: '补充当前运行', queue: '下一轮处理' };
const operationErrors: Record<Operation, string> = {
  start: '未确认启动结果，请刷新状态。',
  send: '未确认发送结果，内容已保留，请先刷新状态。',
  stop: '未确认停止结果，请刷新状态。',
  refresh: '刷新失败，请重试。',
  history: '较早消息暂未加载，请重试。',
  open: '工作区会话暂未打开，请刷新状态后重试。',
};
const modelKey = (selection: NativeRunSelection['model']) =>
  JSON.stringify([
    selection.provider,
    selection.model,
    selection.maxTokens,
    selection.reasoningEffort ?? null,
  ]);
const expertKey = (selection: NativeRunSelection['executor']) =>
  selection.kind === 'builtin'
    ? 'builtin'
    : JSON.stringify([selection.ref.id, selection.ref.version]);
const activeRun = (run: NativeRunSummary | null) =>
  run !== null &&
  (run.resources === 'held' || ['requested', 'running', 'waiting-for-input'].includes(run.status));
const runKey = (view: NativeRunPanelView) =>
  view.kind === 'ready' && view.run
    ? JSON.stringify([view.run.runId, view.run.generation, view.run.segmentId])
    : view.kind;
const reason = (action: NativeRunAction) => (action.kind === 'available' ? '' : action.message);

function RunIcon({ kind }: { kind: 'refresh' | 'send' | 'stop' | 'agent' | 'close' }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      {kind === 'refresh' ? (
        <path d="M13 6a5.1 5.1 0 1 0 .1 3M13 2v4H9" />
      ) : kind === 'send' ? (
        <path d="M8 13V3m-4 4 4-4 4 4" />
      ) : kind === 'stop' ? (
        <rect x="4" y="4" width="8" height="8" rx="1" />
      ) : kind === 'close' ? (
        <path d="m4 4 8 8m0-8-8 8" />
      ) : (
        <path d="M5 3h6l2 3v6H3V6l2-3Zm1 4v2m4-2v2M8 1v2M6 12v2m4-2v2" />
      )}
    </svg>
  );
}

type TurnEnd = NonNullable<ReadyView['turnEnd']>;
function RunState({
  run,
  turnEnd,
}: {
  run: NativeRunSummary | null;
  turnEnd?: TurnEnd | undefined;
}) {
  if (!run) return <span className="zm-native-run__status">尚未开始</span>;
  const label =
    run.status === 'running' && run.native?.status === 'idle' && turnEnd
      ? ['completed', 'forked'].includes(turnEnd.reason.kind)
        ? '等待继续'
        : '需要处理'
      : {
          requested: '正在启动',
          running: '运行中',
          'waiting-for-input': '等待补充',
          completed:
            run.submission || run.resultDelivery?.kind === 'delivered'
              ? (run.submission?.roundId ??
                (run.resultDelivery?.kind === 'delivered' ? run.resultDelivery.roundId : undefined))
                ? '已提交评审'
                : '产物已提交'
              : '本轮已结束',
          failed: '运行失败',
          cancelled: run.stopPhase === 'confirmed' ? '已停止' : '运行已取消',
        }[run.status];
  return (
    <span className="zm-native-run__status" data-state={run.status}>
      <span className="zm-native-run__dot" aria-hidden="true" />
      {label}
    </span>
  );
}

function TurnNotice({
  run,
  turnEnd,
}: {
  run: NativeRunSummary | null;
  turnEnd?: TurnEnd | undefined;
}) {
  if (
    !turnEnd ||
    !run ||
    run.native?.status !== 'idle' ||
    run.resultDelivery ||
    run.stopPhase !== 'none'
  )
    return null;
  const text = {
    completed: '本轮回复已结束，尚未提交产物。可补充要求后继续。',
    blocked: '本轮执行受阻，可补充信息后继续。',
    'max-tokens': '本轮达到输出上限，尚未提交产物。可发送消息继续。',
    error: '本轮执行失败，可查看会话后重试。',
    aborted: '本轮已中止，尚未提交产物。',
    interrupted: '本轮已中断，尚未提交产物。',
    forked: '本轮会话已分支，尚未提交产物。',
    unknown: '本轮已结束，尚未提交产物。',
  }[turnEnd.reason.kind];
  return (
    <p className="zm-native-run__notice" role="status">
      {text}
    </p>
  );
}

function Receipt({ run }: { run: NativeRunSummary | null }) {
  if (!run) return null;
  const notices = [
    run.resultDelivery?.kind === 'pending'
      ? run.resultDelivery.phase === 'delivery-unconfirmed'
        ? '交付结果待核实，请刷新'
        : run.resultDelivery.phase === 'draining'
          ? '正在结束运行并固定产物'
          : '正在确认产物已保存'
      : '',
    run.dispatch === 'reserved'
      ? '等待运行端接收'
      : run.dispatch === 'unknown'
        ? '接收结果待核实'
        : !run.acknowledged
          ? '运行端已收到'
          : '',
    run.stopPhase === 'requested'
      ? '已请求停止，等待确认'
      : run.stopPhase === 'receipt-rejected'
        ? '停止回执未确认，请刷新'
        : run.stopPhase === 'confirmed'
          ? '已确认停止'
          : '',
    run.native?.status === 'detached' && !run.resultDelivery ? '会话连接已断开' : '',
    run.resources === 'held' && !['requested', 'running', 'waiting-for-input'].includes(run.status)
      ? '资源仍占用，暂不能重新开始'
      : '',
  ].filter(Boolean);
  if (!notices.length) return null;
  return (
    <p className="zm-native-run__notice" role="status">
      {notices.join(' · ')}
    </p>
  );
}

// This is a display hint for the original composition's initial task prompt,
// never an execution classification or a rewrite of its persisted/sent text.
function initialTaskInstructions(message: NativeRunMessage) {
  return (
    message.role === 'user' &&
    (message.text.length > 800 || message.text.split('\n').length > 10) &&
    message.text.startsWith('执行当前节点：') &&
    message.text.includes('\n预期产物：') &&
    message.text.includes('\n节点输入说明：') &&
    message.text.includes('\n按固定输入清单处理，返回产物草稿与必要说明。')
  );
}
function Message({ message, initial = false }: { message: NativeRunMessage; initial?: boolean }) {
  const title =
    message.label ||
    { user: '用户', assistant: 'Agent', tool: '工具记录', system: '运行记录' }[message.role];
  if (message.role === 'tool')
    return (
      <li className="zm-native-run__message" data-role="tool">
        <details className="zm-native-run__disclosure">
          <summary>
            <span className="zm-native-run__disclosure-icon">
              <ControlIcon direction="right" />
            </span>
            <span className="zm-native-run__disclosure-label">{title}</span>
          </summary>
          <pre>{message.text}</pre>
        </details>
      </li>
    );
  return (
    <li
      className="zm-native-run__message"
      data-role={message.role}
      data-initial-task={initial || undefined}
      aria-label={title}
    >
      {message.role === 'assistant' && (
        <span className="zm-native-run__message-mark" aria-hidden="true">
          <RunIcon kind="agent" />
        </span>
      )}
      <div className="zm-native-run__message-body">
        {initial ? (
          <details className="zm-native-run__instructions zm-native-run__disclosure">
            <summary>
              <span className="zm-native-run__disclosure-icon">
                <ControlIcon direction="right" />
              </span>
              <span className="zm-native-run__disclosure-label">初始任务说明</span>
              <span className="zm-native-run__instructions-hint">完整内容</span>
            </summary>
            <div className="zm-native-run__message-text" tabIndex={0} aria-label="完整初始任务说明">
              {message.text}
            </div>
          </details>
        ) : (
          <div className="zm-native-run__message-text">{message.text}</div>
        )}
        {message.delivery && (
          <small className="zm-native-run__delivery">
            {
              {
                received: '已收到 · 待处理',
                recorded: '已进入会话记录',
                streaming: '正在输出…',
                syncing: '正在同步完整消息…',
              }[message.delivery]
            }
          </small>
        )}
      </div>
    </li>
  );
}

function Selection({
  view,
  disabled,
  onChange: publishSelection,
}: {
  view: ReadyView;
  disabled: boolean;
  onChange(selection: NativeRunSelection): void;
}) {
  const selected = view.selection;
  const [expanded, setExpanded] = useState(!view.run);
  const [partialModel, setPartialModel] = useState<NativeRunSelection['model']>();
  const [partialExecutor, setPartialExecutor] = useState<NativeRunSelection['executor']>();
  const [partialWorkspace, setPartialWorkspace] = useState<NativeRunSelection['workspace']>();
  const chosenWorkspace = selected?.workspace ?? partialWorkspace;
  const [partialKnowledge, setPartialKnowledge] = useState<
    NativeRunSelection['knowledge'] | null
  >();
  const chosenKnowledge =
    partialKnowledge === undefined ? selected?.knowledge : (partialKnowledge ?? undefined);
  const onChange = (next: NativeRunSelection) =>
    publishSelection({ ...next, ...(chosenKnowledge ? { knowledge: chosenKnowledge } : {}) });
  function changeKnowledge(next: NativeRunSelection['knowledge']) {
    setPartialKnowledge(next ?? null);
    if (model && expert)
      publishSelection({
        model: model.value,
        executor: expert.value,
        ...(chosenWorkspace ? { workspace: chosenWorkspace } : {}),
        ...(next ? { knowledge: next } : {}),
      });
  }
  const perRunPublication =
    chosenWorkspace?.kind === 'local' &&
    view.workspaces?.find((item) => item.id === chosenWorkspace.id)?.publication === 'per-run';
  const publishRanges = chosenWorkspace?.kind === 'local' ? (chosenWorkspace.publish ?? []) : [];
  const publicationValid = validPublication(publishRanges);
  function changePublication(publish: readonly WorkspacePublishRange[]) {
    if (disabled || chosenWorkspace?.kind !== 'local') return;
    const workspace = { ...chosenWorkspace, publish };
    setPartialWorkspace(workspace);
    if (model && expert) onChange({ model: model.value, executor: expert.value, workspace });
  }
  const chosenModel = selected?.model ?? partialModel;
  const chosenExecutor = selected?.executor ?? partialExecutor;
  const model =
    view.models.kind === 'ready'
      ? view.models.items.find(
          (item) => chosenModel && modelKey(item.value) === modelKey(chosenModel),
        )
      : undefined;
  const expert =
    view.experts.kind === 'ready'
      ? view.experts.items.find(
          (item) => chosenExecutor && expertKey(item.value) === expertKey(chosenExecutor),
        )
      : undefined;
  return (
    <details
      className="zm-native-run__config"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        <span className="zm-native-run__config-values">
          {model?.label ?? '未选模型'}
          <span aria-hidden="true"> · </span>
          {expert?.label ?? '未选执行者'}
        </span>
        <span className="zm-native-run__config-action">
          {disabled ? '配置与资源' : '配置'}
          <ControlIcon direction="down" />
        </span>
      </summary>
      <div className="zm-native-run__selection" aria-label={disabled ? '本轮固定配置' : '运行配置'}>
        <div className="zm-native-run__choice">
          <span>模型</span>
          {disabled ? (
            <strong>{model?.label ?? selected?.model.model ?? '未提供'}</strong>
          ) : (
            <SingleSelect
              label="选择模型"
              popupMinWidth={320}
              value={model?.id ?? ''}
              disabled={view.models.kind !== 'ready' || !view.models.items.length}
              triggerContent={
                <>
                  <span>
                    {model?.label ?? (view.models.kind === 'loading' ? '加载中…' : '选择模型')}
                  </span>
                  <ControlIcon direction="down" />
                </>
              }
              options={
                view.models.kind === 'ready'
                  ? view.models.items.map(({ id, label }) => ({ value: id, label }))
                  : []
              }
              onValueChange={(id) => {
                if (view.models.kind !== 'ready') return;
                const choice = view.models.items.find((item) => item.id === id);
                if (!choice) return;
                setPartialModel(choice.value);
                if (expert)
                  onChange({
                    model: choice.value,
                    executor: expert.value,
                    ...(chosenWorkspace ? { workspace: chosenWorkspace } : {}),
                  });
              }}
            />
          )}
          {!disabled && view.models.kind !== 'ready' && <small>{view.models.message}</small>}
          {!disabled && view.models.kind === 'ready' && !view.models.items.length && (
            <small>暂无可用模型</small>
          )}
        </div>
        <div className="zm-native-run__choice">
          <span>执行者</span>
          {disabled ? (
            <strong>
              {expert?.label ??
                (selected?.executor.kind === 'builtin'
                  ? '内置 Agent'
                  : selected
                    ? '计划专家'
                    : '未提供')}
            </strong>
          ) : (
            <SingleSelect
              label="选择执行者"
              popupMinWidth={280}
              value={expert?.id ?? ''}
              disabled={view.experts.kind !== 'ready' || !view.experts.items.length}
              triggerContent={
                <>
                  <span>
                    {expert?.label ?? (view.experts.kind === 'loading' ? '加载中…' : '选择执行者')}
                  </span>
                  <ControlIcon direction="down" />
                </>
              }
              options={
                view.experts.kind === 'ready'
                  ? view.experts.items.map(({ id, label }) => ({ value: id, label }))
                  : []
              }
              onValueChange={(id) => {
                if (view.experts.kind !== 'ready') return;
                const choice = view.experts.items.find((item) => item.id === id);
                if (!choice) return;
                setPartialExecutor(choice.value);
                if (model)
                  onChange({
                    model: model.value,
                    executor: choice.value,
                    ...(chosenWorkspace ? { workspace: chosenWorkspace } : {}),
                  });
              }}
            />
          )}
          {!disabled && view.experts.kind !== 'ready' && <small>{view.experts.message}</small>}
          {!disabled && view.experts.kind === 'ready' && !view.experts.items.length && (
            <small>暂无可用执行者</small>
          )}
        </div>
        {(view.workspaces !== undefined ||
          (chosenWorkspace && chosenWorkspace.kind !== 'text-only')) && (
          <div className="zm-native-run__choice">
            <span>执行范围</span>
            {disabled ? (
              <strong>
                {chosenWorkspace?.kind === 'unavailable'
                  ? '工作区授权已失效'
                  : chosenWorkspace?.kind === 'local'
                    ? (view.workspaces?.find((item) => item.id === chosenWorkspace.id)?.label ??
                      '工作区授权已失效')
                    : '仅使用任务材料'}
              </strong>
            ) : (
              <SingleSelect
                label="执行范围"
                popupMinWidth={320}
                value={
                  chosenWorkspace?.kind === 'unavailable'
                    ? 'unavailable'
                    : chosenWorkspace?.kind === 'local'
                      ? `workspace:${chosenWorkspace.id}`
                      : 'text-only'
                }
                options={[
                  ...(chosenWorkspace?.kind === 'unavailable'
                    ? [{ value: 'unavailable', label: '工作区授权已失效', disabled: true }]
                    : []),
                  { value: 'text-only', label: '仅使用任务材料' },
                  ...(view.workspaces ?? []).map((item) => ({
                    value: `workspace:${item.id}`,
                    label: `${item.label} · ${item.access === 'write' ? '可编辑' : '只读'}${item.publish ? ' · 可发布文件' : ''}`,
                  })),
                ]}
                onValueChange={(value) => {
                  const choice =
                    value === 'text-only'
                      ? { kind: 'text-only' as const }
                      : view.workspaces?.some((item) => `workspace:${item.id}` === value)
                        ? { kind: 'local' as const, id: value.slice('workspace:'.length) }
                        : undefined;
                  if (!choice) return;
                  setPartialWorkspace(choice);
                  if (model && expert)
                    onChange({ model: model.value, executor: expert.value, workspace: choice });
                }}
              />
            )}
          </div>
        )}
        {view.knowledgeLibraries && (
          <div className="zm-native-run__choice">
            <span>知识库</span>
            {disabled ? (
              <strong>
                {chosenKnowledge
                  ? view.knowledgeLibraries.kind === 'ready'
                    ? (view.knowledgeLibraries.items.find(
                        (item) => item.id === chosenKnowledge.libraryId,
                      )?.label ?? '本轮知识库')
                    : '本轮知识库'
                  : '未使用'}
              </strong>
            ) : (
              <SingleSelect
                label="选择本轮知识库"
                popupMinWidth={320}
                value={chosenKnowledge?.libraryId ?? ''}
                options={[
                  { value: '', label: '不使用知识库' },
                  ...(view.knowledgeLibraries.kind === 'ready'
                    ? view.knowledgeLibraries.items.map((item) => ({
                        value: item.id,
                        label: item.label,
                      }))
                    : []),
                ]}
                onValueChange={(libraryId) =>
                  changeKnowledge(libraryId ? { libraryId, allowDrafts: false } : undefined)
                }
              />
            )}
            {chosenKnowledge && (
              <label className="zm-checkbox">
                <input
                  type="checkbox"
                  checked={chosenKnowledge.allowDrafts}
                  disabled={disabled}
                  onChange={(event) =>
                    changeKnowledge({ ...chosenKnowledge, allowDrafts: event.target.checked })
                  }
                />
                允许 Agent 创建知识草稿
              </label>
            )}
            {!disabled && view.knowledgeLibraries.kind !== 'ready' && (
              <small>{view.knowledgeLibraries.message}</small>
            )}
          </div>
        )}
        {disabled && <span className="zm-native-run__fixed">本轮配置已固定</span>}
      </div>
      {perRunPublication && (
        <details className="zm-native-run__resources zm-native-run__disclosure">
          <summary>
            <span className="zm-native-run__disclosure-icon">
              <ControlIcon direction="right" />
            </span>
            <span className="zm-native-run__disclosure-label">文件交付范围</span>
            <span className="zm-native-run__resource-count">
              {publishRanges.length || '未授权'}
            </span>
          </summary>
          <WorkspacePublishRanges
            ranges={publishRanges}
            disabled={disabled}
            valid={publicationValid}
            onChange={changePublication}
          />
        </details>
      )}
      {!!view.resources.length && (
        <details className="zm-native-run__resources zm-native-run__disclosure">
          <summary>
            <span className="zm-native-run__disclosure-icon">
              <ControlIcon direction="right" />
            </span>
            <span className="zm-native-run__disclosure-label">本轮资源</span>
            <span className="zm-native-run__resource-count">{view.resources.length}</span>
          </summary>
          <ul>
            {view.resources.map((resource) => (
              <li key={resource.id}>
                <span>{{ skill: 'Skill', mcp: 'MCP', input: '输入材料' }[resource.kind]}</span>
                <strong>{resource.name}</strong>
                <span>
                  {{ fixed: '已固定', unavailable: '不可用', unknown: '待核实' }[resource.status]}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </details>
  );
}

/** Rendering is passive. Target remounts fence local drafts and late command receipts. */
export function NativeRunPanel(props: NativeRunPanelProps) {
  const { target } = props;
  return (
    <RunPanel
      key={JSON.stringify([
        target.spaceId,
        target.taskId,
        target.planId,
        target.revision,
        target.nodeId,
      ])}
      {...props}
    />
  );
}

function RunPanel(props: NativeRunPanelProps) {
  const { target, view, busy } = props;
  const id = useId();
  const [draft, setDraft] = useState('');
  useUnsavedChanges(draft.length > 0);
  const dirtyCallback = useRef(props.onDirtyChange);
  dirtyCallback.current = props.onDirtyChange;
  useEffect(() => {
    props.onDirtyChange?.(draft.length > 0);
  }, [draft, props.onDirtyChange]);
  useEffect(
    () => () => {
      dirtyCallback.current?.(false);
    },
    [],
  );
  const [selectedMode, setMode] = useState<NativeRunSendMode>('followup');
  const [pending, setPending] = useState<ReadonlySet<Operation>>(new Set());
  const [error, setError] = useState('');
  const active = useRef(new Set<Operation>());
  const mounted = useRef(false);
  const editVersion = useRef(0);
  const context = useRef(runKey(view));
  context.current = runKey(view);
  const timeline = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const lastMessage = view.kind === 'ready' ? view.messages.at(-1) : undefined;
  const firstUserMessage =
    view.kind === 'ready' ? view.messages.find((message) => message.role === 'user') : undefined;
  const turnEnd =
    view.kind === 'ready' &&
    view.turnEnd &&
    !view.messages.some((message) => message.sequence > view.turnEnd!.seq)
      ? view.turnEnd
      : undefined;
  useEffect(() => {
    if (following.current && timeline.current)
      timeline.current.scrollTop = timeline.current.scrollHeight;
  }, [lastMessage?.id, lastMessage?.text]);

  const running = (operation: Operation) => busy === operation || pending.has(operation);
  async function command(operation: Operation, execute: () => Promise<void>, done?: () => void) {
    if (busy === operation || active.current.has(operation)) return;
    if (
      ['start', 'send'].includes(operation) &&
      (busy === 'stop' ||
        active.current.has('stop') ||
        (view.kind === 'ready' && view.run?.stopPhase === 'requested'))
    )
      return;
    if (
      ['start', 'send'].includes(operation) &&
      (active.current.has('start') || active.current.has('send'))
    )
      return;
    const stamp = context.current;
    active.current.add(operation);
    setPending(new Set(active.current));
    setError('');
    try {
      await execute();
      if (mounted.current && context.current === stamp) done?.();
    } catch {
      if (mounted.current && context.current === stamp) setError(operationErrors[operation]);
    } finally {
      active.current.delete(operation);
      if (mounted.current) setPending(new Set(active.current));
    }
  }
  const ready = view.kind === 'ready' ? view : undefined;
  const matching =
    !ready?.run ||
    (ready.run.taskId === target.taskId &&
      ready.run.planId === target.planId &&
      ready.run.revision === target.revision &&
      ready.run.nodeId === target.nodeId);
  const run = matching ? (ready?.run ?? null) : null;
  const stopping = running('stop') || run?.stopPhase === 'requested';
  const held = activeRun(run);
  const availableModes =
    ready && matching ? modes.filter((mode) => ready.actions.send[mode].kind === 'available') : [];
  const mode = availableModes.includes(selectedMode) ? selectedMode : availableModes[0];
  const selectedWorkspace = ready?.selection?.workspace;
  const publicationReady =
    selectedWorkspace?.kind !== 'local' ||
    selectedWorkspace.publish === undefined ||
    (ready?.workspaces?.find((item) => item.id === selectedWorkspace.id)?.publication ===
      'per-run' &&
      validPublication(selectedWorkspace.publish));
  const selectionReady =
    !!ready?.selection &&
    publicationReady &&
    selectedWorkspace?.kind !== 'unavailable' &&
    (selectedWorkspace?.kind !== 'local' ||
      !!ready.workspaces?.some((item) => item.id === selectedWorkspace.id)) &&
    ready.models.kind === 'ready' &&
    ready.experts.kind === 'ready' &&
    ready.models.items.some((item) => modelKey(item.value) === modelKey(ready.selection!.model)) &&
    ready.experts.items.some(
      (item) => expertKey(item.value) === expertKey(ready.selection!.executor),
    );
  const canStart =
    !!ready && matching && !held && selectionReady && ready.actions.start.kind === 'available';
  const hasRun = !!run;
  const sendUnavailable =
    ready && matching
      ? (['steer', 'followup', 'queue'] as const)
          .map((item) => reason(ready.actions.send[item]))
          .find(Boolean)
      : '';
  const sendHint =
    mode === 'queue'
      ? '排入下一轮，不影响当前运行。'
      : mode === 'steer'
        ? '补充发送到当前运行，以实际接收回执为准。'
        : mode === 'followup'
          ? '发送到此工作会话。'
          : sendUnavailable || '当前不能发送，请刷新状态。';

  function send(event: FormEvent) {
    event.preventDefault();
    if (
      !ready ||
      !hasRun ||
      !matching ||
      !mode ||
      !draft.trim() ||
      draft.length > TEXT_LIMIT ||
      running('send') ||
      running('start') ||
      stopping
    )
      return;
    const version = editVersion.current,
      text = draft;
    void command(
      'send',
      () => props.onSend(text, mode),
      () => {
        if (editVersion.current === version) {
          setDraft('');
          editVersion.current++;
        }
      },
    );
  }

  const showComposer = hasRun && (availableModes.length > 0 || draft.length > 0);
  const stopped =
    run?.status === 'cancelled' && run.stopPhase === 'confirmed' && run.resources === 'settled';
  const submittedReadOnly =
    run?.status === 'completed' &&
    run.resources === 'settled' &&
    (run.resultDelivery?.kind === 'delivered' || !!run.submission) &&
    ready?.actions.start.kind !== 'available';
  const inactiveHint = !ready
    ? ''
    : !hasRun
      ? reason(ready.actions.start)
      : run?.status === 'completed' && !held
        ? reason(ready.actions.start)
        : stopped
          ? reason(ready.actions.start)
          : sendUnavailable || '本轮暂不能发送。';
  const startAction = ready &&
    !held &&
    !(run?.status === 'completed' && ready.actions.start.kind !== 'available') && (
      <Button
        variant={showComposer ? 'secondary' : 'primary'}
        busy={running('start')}
        busyLabel="正在启动…"
        disabled={!canStart || running('send') || stopping}
        onClick={() => {
          if (canStart && ready.selection)
            void command('start', () => props.onStart(ready.selection!));
        }}
      >
        {hasRun ? '开始新一轮' : '开始执行'}
      </Button>
    );

  return (
    <section className="zm-native-run" aria-labelledby={`${id}-title`}>
      <header className="zm-native-run__header">
        <div className="zm-native-run__heading">
          <RunIcon kind="agent" />
          <h2 id={`${id}-title`}>{target.title}</h2>
        </div>
        <div className="zm-native-run__header-actions">
          {ready && matching && <RunState run={run} turnEnd={turnEnd} />}
          {ready && matching && run?.native && props.onOpenSession && (
            <Button
              variant="quiet"
              busy={running('open')}
              busyLabel="正在打开…"
              onClick={() => void command('open', props.onOpenSession!)}
            >
              在工作区中打开
            </Button>
          )}
          {ready && matching && props.onManageWorkspaces && (
            <Button variant="quiet" onClick={props.onManageWorkspaces}>
              管理目录授权
            </Button>
          )}
          {ready && matching && hasRun && (held || ready.actions.stop.kind === 'available') && (
            <Button
              variant="quiet"
              disabled={ready.actions.stop.kind !== 'available'}
              busy={running('stop')}
              busyLabel="请求停止…"
              onClick={() => {
                if (ready.actions.stop.kind === 'available') void command('stop', props.onStop);
              }}
            >
              <RunIcon kind="stop" />
              停止运行
            </Button>
          )}
          <Button
            variant="quiet"
            busy={running('refresh')}
            busyLabel="刷新中…"
            onClick={() => void command('refresh', props.onRefresh)}
            aria-label="刷新工作会话"
          >
            <RunIcon kind="refresh" />
            刷新
          </Button>
          {props.onClose && (
            <Button variant="quiet" aria-label="关闭" onClick={props.onClose}>
              <RunIcon kind="close" />
            </Button>
          )}
        </div>
      </header>
      {target.description && target.description !== target.title && (
        <details className="zm-native-run__context">
          <summary>
            工作说明
            <ControlIcon direction="down" />
          </summary>
          <p tabIndex={0} aria-label="完整工作说明">
            {target.description}
          </p>
        </details>
      )}
      {view.kind === 'loading' ? (
        <div className="zm-native-run__empty" role="status">
          正在读取工作会话…
        </div>
      ) : view.kind === 'unavailable' || !matching ? (
        <div className="zm-native-run__empty" role="status">
          <strong>工作会话暂不可用</strong>
          <p>{view.kind === 'unavailable' ? view.message : '当前节点的会话尚未同步，请刷新。'}</p>
        </div>
      ) : (
        <>
          <Selection
            key={runKey(view)}
            view={view}
            disabled={held || submittedReadOnly || running('start')}
            onChange={props.onSelectionChange}
          />
          <Receipt run={run} />
          <TurnNotice run={run} turnEnd={turnEnd} />
          {props.reviewAction}
          <div
            className="zm-native-run__timeline"
            ref={timeline}
            onScroll={(event) => {
              const node = event.currentTarget;
              following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 64;
            }}
          >
            {view.hasEarlier && (
              <Button
                variant="quiet"
                busy={running('history')}
                busyLabel="加载中…"
                onClick={() => {
                  following.current = false;
                  void command('history', props.onLoadEarlier);
                }}
              >
                加载较早消息
              </Button>
            )}
            {view.messages.length ? (
              <ol
                className="zm-native-run__messages"
                role="log"
                aria-label="会话消息"
                aria-live="polite"
                aria-relevant="additions"
              >
                {view.messages.map((message) => (
                  <Message
                    key={message.id}
                    message={message}
                    initial={message === firstUserMessage && initialTaskInstructions(message)}
                  />
                ))}
              </ol>
            ) : (
              <div className="zm-native-run__empty">
                <RunIcon kind="agent" />
                <strong>
                  {hasRun ? '等待会话消息' : selectionReady ? '准备就绪' : '配置此次执行'}
                </strong>
              </div>
            )}
          </div>
          <div className="zm-native-run__footer">
            {showComposer ? (
              <form onSubmit={send} className="zm-native-run__composer">
                <label className="zm-native-run__sr-only" htmlFor={`${id}-message`}>
                  发送给 Agent 的消息
                </label>
                <textarea
                  id={`${id}-message`}
                  value={draft}
                  maxLength={TEXT_LIMIT}
                  rows={2}
                  placeholder={
                    mode === 'queue' ? '留给下一轮处理的内容…' : '补充要求，或继续这项工作…'
                  }
                  aria-describedby={`${id}-send-hint`}
                  onChange={(event) => {
                    editVersion.current++;
                    setDraft(event.target.value);
                  }}
                />
                <div className="zm-native-run__composer-actions">
                  {availableModes.length > 1 ? (
                    <SingleSelect
                      label="发送方式"
                      value={mode ?? ''}
                      options={availableModes.map((value) => ({ value, label: modeLabels[value] }))}
                      onValueChange={(value) => setMode(value as NativeRunSendMode)}
                    />
                  ) : (
                    <span className="zm-native-run__mode">
                      {mode ? modeLabels[mode] : '发送暂不可用'}
                    </span>
                  )}
                  <span className="zm-native-run__counter">
                    {draft.length >= TEXT_LIMIT * 0.8 ? `${draft.length}/${TEXT_LIMIT}` : ''}
                  </span>
                  {startAction}
                  <Button
                    type="submit"
                    variant="primary"
                    busy={running('send')}
                    busyLabel="发送中…"
                    disabled={!mode || !draft.trim() || running('start') || stopping}
                  >
                    <RunIcon kind="send" />
                    {mode === 'queue' ? '排入下一轮' : '发送'}
                  </Button>
                </div>
                <p id={`${id}-send-hint`} className="zm-native-run__hint">
                  {sendHint}
                </p>
              </form>
            ) : (
              <div className="zm-native-run__run-actions">
                {inactiveHint && (
                  <span className="zm-native-run__hint" role="status">
                    {inactiveHint}
                  </span>
                )}
                {startAction}
              </div>
            )}
            {showComposer && !held && reason(view.actions.start) && (
              <p className="zm-native-run__hint">{reason(view.actions.start)}</p>
            )}
            {held && view.actions.stop.kind !== 'available' && (
              <p className="zm-native-run__hint">{reason(view.actions.stop)}</p>
            )}
          </div>
        </>
      )}
      {(props.error || error) && (
        <div className="zm-native-run__error" role="alert">
          {props.error || error}
        </div>
      )}
    </section>
  );
}
