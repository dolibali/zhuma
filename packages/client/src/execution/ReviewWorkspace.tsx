import { useId, useState } from 'react';
import { FileReferences } from './FileReferences.js';
import { Button } from '../workbench/Button.js';
import { Field } from '../workbench/controls.js';
import { useUnsavedChanges } from '../workbench/UnsavedChanges.js';
import type { ExecutionApi, ExecutionNodeWire, ReviewDraft } from './ExecutionApi.js';
import { reviewIdentity, useExecutionCommand, useFormKey } from './interaction.js';
import { createExecutionGoalView } from '../execution-view.js';
import type { NativeReviewApi } from '../run/review-api.js';
import { NativeReviewLauncher } from '../run/NativeReviewWorkspace.js';
import { ReviewBallots } from './ReviewBallots.js';

type Props = {
  api: ExecutionApi;
  node: ExecutionNodeWire;
  nativeReview?: { api: NativeReviewApi; spaceId: string };
  onSubmitted(node: ExecutionNodeWire): void;
};
export function ReviewWorkspace(props: Props) {
  const key = useFormKey(props.api, reviewIdentity(props.node));
  return <ReviewForm key={key} {...props} />;
}
function ReviewForm({ api, node, onSubmitted, nativeReview }: Props) {
  const titleId = useId();
  const goal = createExecutionGoalView(node.goal);
  const round = node.rounds.find((item) => item.id === node.currentRoundId);
  // A review is always tied to its exact submitted artifact, never the latest unrelated one.
  const artifact = node.artifacts.find((item) => item.id === round?.artifactVersionId);
  const [comment, setComment] = useState('');
  useUnsavedChanges(!!comment);
  const command = useExecutionCommand();
  const unavailable = !round || round.status !== 'open' || !artifact;
  function vote(action: ReviewDraft['action']) {
    if (unavailable || !round || !artifact) return;
    if (action !== 'approve' && !comment.trim()) {
      command.setError('请填写评审意见。');
      return;
    }
    const payload = {
      taskId: node.taskId,
      planId: node.planId,
      revision: node.revision,
      nodeId: node.nodeId,
      expectedVersion: node.version,
      roundId: round.id,
      artifactVersionId: artifact.id,
      action,
      ...(comment.trim() ? { comment: comment.trim() } : {}),
    };
    void command.run(
      payload,
      (idempotencyKey, signal) => api.ballot({ ...payload, idempotencyKey }, signal),
      (next) => {
        setComment('');
        onSubmitted(next);
      },
    );
  }
  return (
    <section className="zm-config-form zm-execution-detail" aria-labelledby={titleId}>
      <div className="zm-page-heading">
        <div>
          <p className="zm-eyebrow">评审产物</p>
          <h2 id={titleId}>{goal.title}</h2>
        </div>
      </div>
      {!unavailable && nativeReview && artifact && round && (
        <NativeReviewLauncher
          api={nativeReview.api}
          target={{
            spaceId: nativeReview.spaceId,
            taskId: node.taskId,
            planId: node.planId,
            revision: node.revision,
            nodeId: node.nodeId,
            roundId: round.id,
            artifactVersionId: artifact.id,
          }}
        />
      )}
      {goal.description !== undefined && <p className="zm-execution-text">{goal.description}</p>}
      {command.error && (
        <div role="alert" className="zm-error">
          {command.error}
        </div>
      )}
      {unavailable && <p role="status">当前评审轮次或对应产物不可用，请刷新待办。</p>}
      <article className="zm-execution-artifact" aria-label="本轮提交产物">
        <h3>提交内容{artifact ? ` · 第 ${artifact.version} 版` : ''}</h3>
        <div className="zm-execution-text">{artifact?.text || '无文字正文'}</div>
        {artifact?.links?.map((link, index) => {
          let safe = false;
          try {
            safe = ['http:', 'https:'].includes(new URL(link).protocol);
          } catch {
            /* Display only. */
          }
          return safe ? (
            <p key={index}>
              <a href={link} target="_blank" rel="noopener noreferrer">
                {link}
              </a>
            </p>
          ) : (
            <p key={index}>{link}</p>
          );
        })}
        {artifact && round && (
          <FileReferences
            api={api}
            files={artifact.files ?? []}
            target={{
              taskId: node.taskId,
              planId: node.planId,
              revision: node.revision,
              nodeId: node.nodeId,
              purpose: 'review',
              artifactVersionId: artifact.id,
              roundId: round.id,
            }}
            scopeKey={reviewIdentity(node)}
          />
        )}
      </article>
      <ReviewBallots ballots={round?.ballots ?? []} />
      <Field label="评审意见">
        <textarea
          rows={4}
          maxLength={100000}
          disabled={command.pending || unavailable}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
        />
      </Field>
      <div className="zm-actions">
        <Button
          variant="primary"
          disabled={unavailable}
          busy={command.pending}
          onClick={() => vote('approve')}
        >
          通过
        </Button>
        <Button
          variant="danger"
          disabled={unavailable}
          busy={command.pending}
          onClick={() => vote('request-changes')}
        >
          退回修改
        </Button>
        <Button disabled={unavailable} busy={command.pending} onClick={() => vote('comment')}>
          提交评论
        </Button>
      </div>
    </section>
  );
}
