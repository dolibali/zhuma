import { useEffect, useRef, useState } from 'react';
import { Button } from '../workbench/Button.js';
import { Field } from '../workbench/controls.js';
import type { ExecutionApi, ExecutionNodeWire } from './ExecutionApi.js';

function reviewItemKey(node: ExecutionNodeWire, roundId: string) {
  return `${node.taskId}:${node.planId}:${node.revision}:${node.nodeId}:${roundId}`;
}

export function ReviewWorkspace({
  api,
  node,
  onSubmitted,
}: {
  api: ExecutionApi;
  node: ExecutionNodeWire;
  onSubmitted(node: ExecutionNodeWire): void;
}) {
  const round = node.rounds.find((item) => item.id === node.currentRoundId);
  const artifact =
    node.artifacts.find((item) => item.id === round?.artifactVersionId) ?? node.artifacts.at(-1);
  const itemKey = reviewItemKey(node, round?.id ?? '');
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const key = useRef(crypto.randomUUID());
  const alive = useRef(true);
  const liveItem = useRef(itemKey);
  const seenItem = useRef(itemKey);
  liveItem.current = itemKey;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (seenItem.current === itemKey) return;
    seenItem.current = itemKey;
    key.current = crypto.randomUUID();
    setComment('');
    setError('');
    setPending(false);
  }, [itemKey]);

  function stillHere(savedFor: string) {
    return alive.current && liveItem.current === savedFor;
  }

  async function vote(action: 'approve' | 'request-changes' | 'comment') {
    if (!round || !artifact) {
      setError('这一项当前没有打开的评审。');
      return;
    }
    if (action === 'comment' && comment.trim() === '') {
      setError('请填写评论。');
      return;
    }
    if (action === 'request-changes' && comment.trim() === '') {
      setError('请写明需要修改的地方。');
      return;
    }
    const savedFor = liveItem.current;
    const note = comment.trim();
    const idempotencyKey = key.current;
    const taskId = node.taskId;
    const planId = node.planId;
    const revision = node.revision;
    const nodeId = node.nodeId;
    const version = node.version;
    const roundId = round.id;
    const artifactVersionId = artifact.id;
    setPending(true);
    setError('');
    try {
      const next = await api.ballot({
        taskId,
        planId,
        revision,
        nodeId,
        expectedVersion: version,
        idempotencyKey,
        roundId,
        artifactVersionId,
        action,
        ...(note === '' ? {} : { comment: note }),
      });
      if (!stillHere(savedFor)) return;
      key.current = crypto.randomUUID();
      setComment('');
      onSubmitted(next);
    } catch (caught) {
      if (!stillHere(savedFor)) return;
      setError(caught instanceof Error ? caught.message : '评审没有提交。');
    } finally {
      if (stillHere(savedFor)) setPending(false);
    }
  }

  return (
    <section className="zm-config-form" aria-labelledby="zhuma-review-title">
      <h2 id="zhuma-review-title">评审交付</h2>
      <p>{node.goal}</p>
      {error && (
        <div role="alert" className="zm-error">
          {error}
        </div>
      )}
      <article className="zm-review">
        <h3>当前产物</h3>
        <p>{artifact?.text || '这份产物没有文字说明。'}</p>
        {round?.ballots.map((ballot) => (
          <small key={`${ballot.reviewerId}:${ballot.action}`}>
            {ballot.reviewerId} ·{' '}
            {ballot.action === 'approve'
              ? '通过'
              : ballot.action === 'request-changes'
                ? '退回'
                : ballot.action}
            {ballot.comment ? ` · ${ballot.comment}` : ''}
          </small>
        ))}
      </article>
      <Field label="评审意见">
        <textarea
          rows={4}
          value={comment}
          onChange={(event) => {
            key.current = crypto.randomUUID();
            setComment(event.target.value);
          }}
        />
      </Field>
      <div className="zm-actions">
        <Button busy={pending} busyLabel="正在提交…" onClick={() => void vote('comment')}>
          仅评论
        </Button>
        <Button busy={pending} busyLabel="正在提交…" onClick={() => void vote('approve')}>
          通过
        </Button>
        <Button
          variant="danger"
          busy={pending}
          busyLabel="正在提交…"
          onClick={() => void vote('request-changes')}
        >
          退回修改
        </Button>
      </div>
    </section>
  );
}
