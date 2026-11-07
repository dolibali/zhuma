import { useId, useLayoutEffect, useRef, useState } from 'react';
import { previewFixedDelivery } from '@zhuma/agent-core';
import { FileReferences } from './FileReferences.js';
import { Button } from '../workbench/Button.js';
import { Field } from '../workbench/controls.js';
import { useUnsavedChanges } from '../workbench/UnsavedChanges.js';
import type {
  ExecutionApi,
  ExecutionCommentWire,
  ExecutionNodeWire,
  ReviewDraft,
} from './ExecutionApi.js';
import { reviewIdentity, useExecutionCommand, useFormKey } from './interaction.js';
import { createExecutionGoalView } from '../execution-view.js';
import type { NativeReviewApi } from '../run/review-api.js';
import { NativeReviewLauncher } from '../run/NativeReviewWorkspace.js';
import { ReviewBallots } from './ReviewBallots.js';

function commentOnVersion(comment: ExecutionCommentWire, artifactId: string): boolean {
  if (comment.versionId === undefined && comment.targetId === undefined) return false;
  if (comment.versionId !== undefined && comment.versionId !== artifactId) return false;
  if (comment.targetId !== undefined && comment.targetId !== artifactId) return false;
  return true;
}

type Props = {
  api: ExecutionApi;
  node: ExecutionNodeWire;
  nativeReview?: { api: NativeReviewApi; spaceId: string };
  focusRequest?: object;
  names?: Readonly<Record<string, string>> | undefined;
  onSubmitted(node: ExecutionNodeWire): void;
};
export function ReviewWorkspace(props: Props) {
  const key = useFormKey(props.api, reviewIdentity(props.node));
  return <ReviewForm key={key} {...props} />;
}
function ReviewForm({ api, node, onSubmitted, nativeReview, focusRequest, names }: Props) {
  const titleId = useId();
  const panel = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const opinion = useRef<HTMLTextAreaElement>(null);
  const decision = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const source = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const current = panel.current;
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: 'start', inline: 'nearest' });
    return () => {
      if (current?.contains(document.activeElement) && source?.isConnected)
        source.focus({ preventScroll: true });
    };
  }, [focusRequest]);
  const goal = createExecutionGoalView(node.goal);
  const round = node.rounds.find((item) => item.id === node.currentRoundId);
  // A review is always tied to its exact submitted artifact, never the latest unrelated one.
  const artifact = node.artifacts.find((item) => item.id === round?.artifactVersionId);
  const [comment, setComment] = useState('');
  useUnsavedChanges(!!comment);
  const command = useExecutionCommand();
  const unavailable = !round || round.status !== 'open' || !artifact;
  const preview = artifact ? previewFixedDelivery(node.artifacts, artifact.id) : undefined;
  const pinned = preview?.ok ? preview.preview : undefined;
  const versionComments = artifact
    ? node.comments.filter((item) => commentOnVersion(item, artifact.id))
    : [];
  function vote(action: ReviewDraft['action']) {
    if (unavailable || !round || !artifact) return;
    if (action !== 'approve' && !comment.trim()) {
      command.setError('请填写评审意见。');
      return;
    }
    const cited = versionComments
      .filter((item) => item.status === 'open')
      .map((item) => item.id)
      .filter((id, index, ids) => ids.indexOf(id) === index);
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
      ...(action === 'request-changes' && cited.length > 0 ? { unresolvedCommentIds: cited } : {}),
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
    <section
      ref={panel}
      className="zm-config-form zm-execution-detail zm-review-workspace"
      aria-labelledby={titleId}
    >
      <div className="zm-page-heading">
        <div>
          <p className="zm-eyebrow">评审产物</p>
          <h2 ref={heading} id={titleId} tabIndex={-1}>
            {goal.title}
          </h2>
        </div>
        <Button
          disabled={unavailable}
          onClick={() => {
            opinion.current?.focus({ preventScroll: true });
            decision.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          }}
        >
          填写评审意见
        </Button>
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
      {goal.description !== undefined && (
        <p className="zm-execution-text zm-review-description" tabIndex={0}>
          {goal.description}
        </p>
      )}
      {command.error && (
        <div role="alert" className="zm-error">
          {command.error}
        </div>
      )}
      {unavailable && <p role="status">当前评审轮次或对应产物不可用，请刷新待办。</p>}
      <div className="zm-review-layout">
        <article className="zm-execution-artifact" aria-label="本轮提交产物">
          <h3>提交内容{artifact ? ` · 第 ${artifact.version} 版` : ''}</h3>
          <div
            className="zm-execution-text zm-review-scroll"
            role="region"
            aria-label="提交正文"
            tabIndex={0}
          >
            {pinned?.text || artifact?.text || '无文字正文'}
          </div>
          {pinned?.diff ? (
            <details className="zm-review-diff">
              <summary>与上一版的差异</summary>
              <pre
                className="zm-execution-text zm-review-scroll"
                aria-label="与上一版的差异"
                tabIndex={0}
              >
                {pinned.diff}
              </pre>
            </details>
          ) : pinned?.baseVersion !== undefined ? (
            <p className="zm-muted">与第 {pinned.baseVersion} 版正文相同。</p>
          ) : null}
          {versionComments.length > 0 && (
            <div className="zm-review-comments" aria-label="绑定本版的评论" tabIndex={0}>
              <h4>绑定本版的评论</h4>
              <ul>
                {versionComments.map((item) => (
                  <li key={item.id}>
                    <span className="zm-kind">{item.status === 'open' ? '未解决' : '已解决'}</span>
                    <span className="zm-execution-text">{item.body || '未写正文'}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
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
        <aside ref={decision} className="zm-review-decision" aria-label="评审意见与操作">
          <div
            className="zm-review-comments"
            aria-label="已有评审意见"
            tabIndex={round?.ballots.length ? 0 : undefined}
          >
            <ReviewBallots ballots={round?.ballots ?? []} names={names} />
          </div>
          <Field label="评审意见">
            <textarea
              ref={opinion}
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
        </aside>
      </div>
    </section>
  );
}
