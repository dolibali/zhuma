import { useRef, useState } from 'react';
import { Button } from '../workbench/Button.js';
import { Field } from '../workbench/controls.js';
import type { ExecutionApi, ExecutionNodeWire } from './ExecutionApi.js';

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
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const key = useRef(crypto.randomUUID());

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
    setPending(true);
    setError('');
    try {
      const next = await api.ballot({
        taskId: node.taskId,
        planId: node.planId,
        revision: node.revision,
        nodeId: node.nodeId,
        expectedVersion: node.version,
        idempotencyKey: key.current,
        roundId: round.id,
        artifactVersionId: artifact.id,
        action,
        ...(comment.trim() === '' ? {} : { comment }),
      });
      key.current = crypto.randomUUID();
      setComment('');
      onSubmitted(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '评审没有提交。');
    } finally {
      setPending(false);
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
