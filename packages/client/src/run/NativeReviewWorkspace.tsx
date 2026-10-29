import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { canonicalPayload, type LocalReviewOptionsQuery } from '@zhuma/agent-core';
import { Button } from '../workbench/Button.js';
import { Modal } from '../workbench/controls.js';
import { SingleSelect } from '../workbench/SingleSelect.js';
import type { NativeReviewApi, NativeReviewState, NativeReviewHistoryPage } from './review-api.js';
import { ReviewOutcomeRead } from './ReviewOutcome.js';

type Props = { api: NativeReviewApi; target: LocalReviewOptionsQuery };
type Catalog = Awaited<ReturnType<NativeReviewApi['options']>>;
type StartInput = Parameters<NativeReviewApi['start']>[1];
const reason = (code?: string) =>
  ({
    'review-self-review': '不能评审自己生成的产物',
    'review-author-active': '提交方仍在运行',
    'review-already-voted': '已完成本轮评审',
    'review-expert-unavailable': '专家当前不可用',
    'review-not-assigned': '未分配此专家评审',
    'review-capacity': '评审资源已占用',
    'review-attempt-budget': '已达到本轮重试上限',
    'review-provenance-invalid': '提交来源待核实',
  })[code ?? ''] ?? '暂不可开始';

export function NativeReviewLauncher({ api, target }: Props) {
  const [open, setOpen] = useState(false);
  const signature = canonicalPayload(target);
  const fixed = useMemo(() => structuredClone(target), [signature]);
  const triggerId = useId();
  return (
    <>
      <Button id={triggerId} onClick={() => setOpen(true)}>
        查看评审
      </Button>
      {open && (
        <Modal
          title="评审意见"
          close={() => setOpen(false)}
          restoreFocus={() => document.getElementById(triggerId)?.focus()}
        >
          <div className="zm-form-body" role="region" aria-label="评审内容" tabIndex={0}>
            <ReviewForm key={signature} api={api} target={fixed} />
          </div>
        </Modal>
      )}
    </>
  );
}
/** Original review Session history. Ordinary opening never starts or reconciles. */
export function NativeReviewHistory({
  api,
  target,
  sessionId,
  close,
}: Props & { sessionId: string; close(): void }) {
  const [page, setPage] = useState<NativeReviewHistoryPage>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lifetime = useRef<AbortController>();
  const stopIntent = useRef<{ requestId: string; expectedAttemptVersion: number }>();
  useEffect(() => {
    const active = new AbortController();
    lifetime.current = active;
    void api
      .session(target, sessionId, active.signal)
      .then((value) => {
        if (!active.signal.aborted) setPage(value);
      })
      .catch(() => {
        if (!active.signal.aborted) setError('评审会话暂不可读，请刷新。');
      });
    return () => active.abort();
  }, [api, target, sessionId]);
  async function load(kind: 'refresh' | 'more' | 'recover' | 'stop') {
    const active = lifetime.current;
    if (!active || active.signal.aborted || busy) return;
    setBusy(true);
    setError('');
    try {
      if (kind === 'stop' && !page) return;
      if (kind === 'stop' && !stopIntent.current)
        stopIntent.current = {
          requestId: crypto.randomUUID(),
          expectedAttemptVersion: page!.run.attemptVersion,
        };
      const value =
        kind === 'stop'
          ? await api.stopSession(
              target,
              sessionId,
              { ...page!.run, attemptVersion: stopIntent.current!.expectedAttemptVersion },
              stopIntent.current!.requestId,
              active.signal,
            )
          : kind === 'recover'
            ? await api.recover(target, sessionId, active.signal)
            : await api.session(
                target,
                sessionId,
                active.signal,
                kind === 'more' ? page?.nextAfter : -1,
              );
      active.signal.throwIfAborted();
      setPage(
        kind === 'more' && page
          ? { ...value, messages: [...page.messages, ...value.messages] }
          : value,
      );
    } catch {
      if (!active.signal.aborted) setError('本轮结果尚未确认，请刷新或重试。');
    } finally {
      if (!active.signal.aborted) setBusy(false);
    }
  }
  return (
    <section className="zm-native-run">
      <header className="zm-native-run__header">
        <h2>Agent 评审记录</h2>
        <Button onClick={close}>关闭</Button>
      </header>
      <ReviewOutcomeRead api={api} target={target} />
      {error && (
        <p className="zm-error" role="alert">
          {error}
        </p>
      )}
      {!page ? (
        <p role="status">正在读取原评审会话…</p>
      ) : (
        <>
          <p className="zm-native-run__notice" role="status">
            {page.run.receipt
              ? '评审意见已提交'
              : page.run.resources === 'held'
                ? '本轮结果或资源状态待核实'
                : '本轮评审已结束'}
          </p>
          <div className="zm-native-run__messages" aria-label="原评审会话记录">
            {page.messages.map((message) => (
              <article key={message.id} className="zm-native-run__message">
                <strong>
                  {message.role === 'assistant'
                    ? 'Agent'
                    : message.role === 'tool'
                      ? '工具记录'
                      : '用户'}
                </strong>
                <p className="zm-execution-text">{message.text}</p>
              </article>
            ))}
          </div>
          <div className="zm-actions">
            <Button busy={busy} onClick={() => void load('refresh')}>
              刷新状态
            </Button>
            {page.run.resources === 'held' && !page.run.stopRequested && (
              <Button disabled={busy} onClick={() => void load('stop')}>
                停止评审
              </Button>
            )}
            <Button disabled={busy || page.nextAfter < 0} onClick={() => void load('more')}>
              加载更多记录
            </Button>
            {page.run.resources === 'held' && page.run.phase === 'recovery-required' && (
              <Button disabled={busy} onClick={() => void load('recover')}>
                核对并恢复结果
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
function ReviewForm({ api, target }: Props) {
  return (
    <ReviewOutcomeRead
      api={api}
      target={target}
      openControls={<OpenReviewForm api={api} target={target} />}
    />
  );
}
function OpenReviewForm({ api, target }: Props) {
  const [catalog, setCatalog] = useState<Catalog>();
  const [run, setRun] = useState<NativeReviewState>();
  const [modelId, setModelId] = useState('');
  const [reviewerId, setReviewerId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState<StartInput>();
  const [pastRuns, setPastRuns] = useState<NativeReviewState[]>([]);
  const ignoredRun = useRef<string>();
  const lifetime = useRef<AbortController>();
  async function load(signal: AbortSignal) {
    const value = await api.options(target, signal);
    signal.throwIfAborted();
    setCatalog(value);
    setReviewerId((before) =>
      value.facts.reviewers.some((item) => item.reviewerRef.id === before)
        ? before
        : (value.facts.reviewers.find((item) => item.canStart)?.reviewerRef.id ?? ''),
    );
    if (value.currentRunId && value.currentRunId !== ignoredRun.current) {
      const current = await api.read(target, value.currentRunId, signal);
      signal.throwIfAborted();
      setRun(current);
      setReviewerId(current.reviewerId);
      setRetry(undefined);
    }
  }
  useEffect(() => {
    const active = new AbortController();
    lifetime.current = active;
    void load(active.signal).catch(() => {
      if (!active.signal.aborted) setError('暂时无法读取本轮评审，请刷新。');
    });
    return () => active.abort();
  }, [api, target]);
  useEffect(() => {
    if (!run || run.resources !== 'held') return;
    const active = new AbortController();
    const timer = setInterval(() => {
      if (!document.hidden)
        void api
          .read(target, run.runId, active.signal)
          .then((value) => {
            if (!active.signal.aborted) setRun(value);
          })
          .catch(() => {
            if (!active.signal.aborted) setError('评审状态暂未同步，请刷新。');
          });
    }, 2500);
    return () => {
      clearInterval(timer);
      active.abort();
    };
  }, [api, target, run?.runId, run?.resources]);
  async function command(work: (signal: AbortSignal) => Promise<void>) {
    const active = lifetime.current;
    if (busy || !active || active.signal.aborted) return;
    setBusy(true);
    setError('');
    try {
      await work(active.signal);
    } catch {
      if (!active.signal.aborted) setError('操作尚未确认，请刷新状态或使用原请求重试。');
    } finally {
      if (!active.signal.aborted) setBusy(false);
    }
  }
  const reviewer = catalog?.facts.reviewers.find((item) => item.reviewerRef.id === reviewerId);
  const model =
    catalog?.models.kind === 'ready'
      ? catalog.models.items.find((item) => item.id === modelId)
      : undefined;
  const locked = busy || !!retry || !!run;
  return (
    <div className="zm-config-form">
      <p className="zm-muted">评审本次提交的文字与文件</p>
      {error && (
        <div className="zm-error" role="alert">
          {error}
        </div>
      )}
      {!catalog ? (
        <p role="status">正在读取评审安排…</p>
      ) : (
        <>
          <label>评审专家</label>
          <SingleSelect
            label="评审专家"
            popupMinWidth={320}
            value={reviewerId}
            disabled={locked}
            options={catalog.facts.reviewers.map((item) => ({
              value: item.reviewerRef.id,
              label: item.name,
              disabled: !item.canStart,
            }))}
            onValueChange={setReviewerId}
          />
          {reviewer && !reviewer.canStart && <small>{reason(reviewer.unavailableReason)}</small>}
          {!catalog.facts.reviewers.length && <p>本轮没有可启动的 Agent 评审专家。</p>}
          <label>本机模型</label>
          <SingleSelect
            label="评审模型"
            popupMinWidth={320}
            value={modelId}
            disabled={locked || catalog.models.kind !== 'ready'}
            options={
              catalog.models.kind === 'ready'
                ? catalog.models.items.map((item) => ({ value: item.id, label: item.label }))
                : []
            }
            onValueChange={setModelId}
          />
          {catalog.models.kind !== 'ready' && <small>{catalog.models.message}</small>}
          {run && (
            <div className="zm-native-run__notice" role="status">
              {run.receipt
                ? run.receipt.action === 'approve'
                  ? '评审已通过'
                  : run.receipt.action === 'request-changes'
                    ? '已退回修改'
                    : '评审意见已提交'
                : run.stopRequested
                  ? '正在停止评审'
                  : run.resources === 'held'
                    ? 'Agent 正在评审'
                    : run.status === 'failed'
                      ? '评审未完成'
                      : run.status === 'cancelled'
                        ? '评审已停止'
                        : '评审结果待核实'}
              {run.failure && (
                <p>
                  {run.failure.code === 'review-read-required'
                    ? '专家未完成所需材料读取，请核对后重新评审。'
                    : '本轮评审未完成，请核对提交材料。'}
                </p>
              )}
            </div>
          )}
          {!!pastRuns.length && (
            <div className="zm-native-run__notice" aria-label="本轮已有评审">
              {pastRuns.map((previous) => (
                <p key={previous.runId}>
                  {catalog.facts.reviewers.find(
                    (item) => item.reviewerRef.id === previous.reviewerId,
                  )?.name ?? previous.reviewerId}{' '}
                  ·{' '}
                  {previous.receipt?.action === 'approve'
                    ? '已通过'
                    : previous.receipt?.action === 'request-changes'
                      ? '已退回修改'
                      : '本轮已结束'}
                </p>
              ))}
            </div>
          )}
          <div className="zm-actions">
            {run?.resources === 'settled' &&
              catalog.facts.reviewers.some((item) => item.canStart) && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void command(async (signal) => {
                      const fresh = await api.options(target, signal);
                      signal.throwIfAborted();
                      setCatalog(fresh);
                      const next = fresh.facts.reviewers.find((item) => item.canStart);
                      if (!next) {
                        setError('当前没有其他可启动的评审专家。');
                        return;
                      }
                      ignoredRun.current = run.runId;
                      setPastRuns((before) =>
                        before.some((item) => item.runId === run.runId) ? before : [...before, run],
                      );
                      setRun(undefined);
                      setRetry(undefined);
                      setReviewerId(next.reviewerRef.id);
                    })
                  }
                >
                  选择下一位评审
                </Button>
              )}
            {!run && (
              <Button
                variant="primary"
                busy={busy}
                disabled={!retry && (!reviewer?.canStart || !model)}
                onClick={() =>
                  void command(async (signal) => {
                    if (!retry && (!model || !reviewer)) return;
                    const input = retry ?? {
                      requestId: crypto.randomUUID(),
                      reviewerId,
                      expectedReviewVersion: catalog.facts.expectedReviewVersion,
                      model: model!.value,
                    };
                    setRetry(input);
                    const runId = await api.start(target, input, signal);
                    const current = await api.read(target, runId, signal);
                    signal.throwIfAborted();
                    setRun(current);
                    setRetry(undefined);
                  })
                }
              >
                {retry ? '重试启动' : '开始评审'}
              </Button>
            )}
            {run?.resources === 'held' && (
              <Button
                busy={busy}
                onClick={() =>
                  void command(async (signal) => {
                    const value = await api.stop(target, run, crypto.randomUUID(), signal);
                    signal.throwIfAborted();
                    setRun(value);
                  })
                }
              >
                停止评审
              </Button>
            )}
            <Button disabled={busy} onClick={() => void command(load)}>
              刷新状态
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
