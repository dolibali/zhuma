import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button } from '../workbench/Button.js';
import { SingleSelect } from '../workbench/SingleSelect.js';
import { ControlIcon } from '../workbench/ControlIcon.js';
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
const modes: readonly NativeRunSendMode[] = ['followup', 'steer', 'queue'];
const modeLabels = { followup: '发送消息', steer: '补充当前运行', queue: '下一轮处理' };
const operationErrors: Record<Operation, string> = {
  start: '未确认启动结果，请刷新状态。',
  send: '未确认发送结果，内容已保留，请先刷新状态。',
  stop: '未确认停止结果，请刷新状态。',
  refresh: '刷新失败，请重试。',
  history: '较早消息暂未加载，请重试。',
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

function RunIcon({ kind }: { kind: 'refresh' | 'send' | 'stop' | 'agent' }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      {kind === 'refresh' ? (
        <path d="M13 6a5.1 5.1 0 1 0 .1 3M13 2v4H9" />
      ) : kind === 'send' ? (
        <path d="M8 13V3m-4 4 4-4 4 4" />
      ) : kind === 'stop' ? (
        <rect x="4" y="4" width="8" height="8" rx="1" />
      ) : (
        <path d="M5 3h6l2 3v6H3V6l2-3Zm1 4v2m4-2v2M8 1v2M6 12v2m4-2v2" />
      )}
    </svg>
  );
}

function RunState({ run }: { run: NativeRunSummary | null }) {
  if (!run) return <span className="zm-native-run__status">尚未开始</span>;
  const label = {
    requested: '正在启动',
    running: '运行中',
    'waiting-for-input': '等待补充',
    completed: '本轮已结束',
    failed: '运行失败',
    cancelled: '运行已取消',
  }[run.status];
  return (
    <span className="zm-native-run__status" data-state={run.status}>
      <span className="zm-native-run__dot" aria-hidden="true" />
      {label}
    </span>
  );
}

function Receipt({ run }: { run: NativeRunSummary | null }) {
  if (!run) return null;
  const notices = [
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
    run.native?.status === 'detached' ? '会话连接已断开' : '',
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

function Message({ message }: { message: NativeRunMessage }) {
  const title =
    message.label ||
    { user: '用户', assistant: 'Agent', tool: '工具记录', system: '运行记录' }[message.role];
  if (message.role === 'tool')
    return (
      <li className="zm-native-run__message" data-role="tool">
        <details>
          <summary>{title}</summary>
          <pre>{message.text}</pre>
        </details>
      </li>
    );
  return (
    <li className="zm-native-run__message" data-role={message.role}>
      <div className="zm-native-run__message-label">{title}</div>
      <div className="zm-native-run__message-text">{message.text}</div>
    </li>
  );
}

function Selection({
  view,
  disabled,
  onChange,
}: {
  view: ReadyView;
  disabled: boolean;
  onChange(selection: NativeRunSelection): void;
}) {
  const selected = view.selection;
  const [partialModel, setPartialModel] = useState<NativeRunSelection['model']>();
  const [partialExecutor, setPartialExecutor] = useState<NativeRunSelection['executor']>();
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
    <div className="zm-native-run__selection" aria-label={disabled ? '本轮固定配置' : '运行配置'}>
      <div className="zm-native-run__choice">
        <span>模型</span>
        {disabled ? (
          <strong>{model?.label ?? selected?.model.model ?? '未提供'}</strong>
        ) : (
          <SingleSelect
            label="选择模型"
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
              if (expert) onChange({ model: choice.value, executor: expert.value });
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
              if (model) onChange({ model: model.value, executor: choice.value });
            }}
          />
        )}
        {!disabled && view.experts.kind !== 'ready' && <small>{view.experts.message}</small>}
        {!disabled && view.experts.kind === 'ready' && !view.experts.items.length && (
          <small>暂无可用执行者</small>
        )}
      </div>
      {disabled && <span className="zm-native-run__fixed">本轮配置已固定</span>}
    </div>
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
  useEffect(() => {
    if (following.current && timeline.current)
      timeline.current.scrollTop = timeline.current.scrollHeight;
  }, [lastMessage?.id, lastMessage?.text]);

  const running = (operation: Operation) => busy === operation || pending.has(operation);
  async function command(operation: Operation, execute: () => Promise<void>, done?: () => void) {
    if (busy === operation || active.current.has(operation)) return;
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
  const held = activeRun(run);
  const availableModes =
    ready && matching ? modes.filter((mode) => ready.actions.send[mode].kind === 'available') : [];
  const mode = availableModes.includes(selectedMode) ? selectedMode : availableModes[0];
  const selectionReady =
    !!ready?.selection &&
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
      running('start')
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

  return (
    <section className="zm-native-run" aria-labelledby={`${id}-title`}>
      <header className="zm-native-run__header">
        <div className="zm-native-run__heading">
          <RunIcon kind="agent" />
          <h2 id={`${id}-title`}>{target.title}</h2>
        </div>
        <div className="zm-native-run__header-actions">
          {ready && matching && <RunState run={run} />}
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
        </div>
      </header>
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
            disabled={held || running('start')}
            onChange={props.onSelectionChange}
          />
          {!!view.resources.length && (
            <details className="zm-native-run__resources">
              <summary>
                本轮资源 <span>{view.resources.length}</span>
              </summary>
              <ul>
                {view.resources.map((resource) => (
                  <li key={resource.id}>
                    <span>{{ skill: 'Skill', mcp: 'MCP', input: '输入材料' }[resource.kind]}</span>
                    <strong>{resource.name}</strong>
                    <span>
                      {
                        { fixed: '已固定', unavailable: '不可用', unknown: '待核实' }[
                          resource.status
                        ]
                      }
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <Receipt run={run} />
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
                  <Message key={message.id} message={message} />
                ))}
              </ol>
            ) : (
              <div className="zm-native-run__empty">
                <RunIcon kind="agent" />
                <strong>{hasRun ? '等待会话消息' : '准备好后，开始执行此节点'}</strong>
                {!hasRun && <p>选择模型和执行者，然后开始。</p>}
              </div>
            )}
          </div>
          <footer className="zm-native-run__footer">
            {hasRun && (
              <form onSubmit={send} className="zm-native-run__composer">
                <label className="zm-native-run__sr-only" htmlFor={`${id}-message`}>
                  发送给 Agent 的消息
                </label>
                <textarea
                  id={`${id}-message`}
                  value={draft}
                  maxLength={TEXT_LIMIT}
                  rows={3}
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
                    {draft.length}/{TEXT_LIMIT}
                  </span>
                  <Button
                    type="submit"
                    variant="primary"
                    busy={running('send')}
                    busyLabel="发送中…"
                    disabled={!mode || !draft.trim() || running('start')}
                  >
                    <RunIcon kind="send" />
                    {mode === 'queue' ? '排入下一轮' : '发送'}
                  </Button>
                </div>
                <p id={`${id}-send-hint`} className="zm-native-run__hint">
                  {sendHint}
                </p>
              </form>
            )}
            <div className="zm-native-run__run-actions">
              {hasRun && (held || view.actions.stop.kind === 'available') && (
                <Button
                  disabled={view.actions.stop.kind !== 'available'}
                  busy={running('stop')}
                  busyLabel="请求停止…"
                  onClick={() => {
                    if (view.actions.stop.kind === 'available') void command('stop', props.onStop);
                  }}
                >
                  <RunIcon kind="stop" />
                  停止运行
                </Button>
              )}
              {!held && (
                <>
                  <span className="zm-native-run__hint">{reason(view.actions.start)}</span>
                  <Button
                    variant={hasRun && mode ? 'secondary' : 'primary'}
                    busy={running('start')}
                    busyLabel="正在启动…"
                    disabled={!canStart || running('send')}
                    onClick={() => {
                      if (canStart && view.selection)
                        void command('start', () => props.onStart(view.selection!));
                    }}
                  >
                    {hasRun ? '开始新一轮' : '开始执行'}
                  </Button>
                </>
              )}
              {held && view.actions.stop.kind !== 'available' && (
                <span className="zm-native-run__hint">{reason(view.actions.stop)}</span>
              )}
            </div>
          </footer>
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
