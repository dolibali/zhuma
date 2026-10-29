import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  canonicalPayload,
  type LocalReviewOptionsQuery,
  type ReviewOutcomeView,
} from '@zhuma/agent-core';
import { Button } from '../workbench/Button.js';
import { FileReferences } from '../execution/FileReferences.js';
import { ReviewBallots } from '../execution/ReviewBallots.js';
import { useFormKey } from '../execution/interaction.js';
import type { NativeReviewApi } from './review-api.js';

type Props = { api: NativeReviewApi; target: LocalReviewOptionsQuery; openControls?: ReactNode };
type Reading =
  { kind: 'loading' } | { kind: 'ready'; value: ReviewOutcomeView } | { kind: 'error' };

/** Fixed business feedback is read independently of native Session availability. */
export function ReviewOutcomeRead(props: Props) {
  const key = useFormKey(props.api, canonicalPayload(props.target));
  return <OutcomeRead key={key} {...props} />;
}
function OutcomeRead({ api, target, openControls }: Props) {
  const [reading, setReading] = useState<Reading>({ kind: 'loading' });
  const request = useRef<AbortController>();
  const alive = useRef(false);
  const load = useCallback(async () => {
    if (!alive.current) return;
    request.current?.abort();
    const active = new AbortController();
    request.current = active;
    const current = () => alive.current && request.current === active && !active.signal.aborted;
    setReading({ kind: 'loading' });
    try {
      const value = await api.outcome(target, active.signal);
      if (current()) setReading({ kind: 'ready', value });
    } catch {
      if (current()) setReading({ kind: 'error' });
    }
  }, [api, target]);
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      request.current?.abort();
    };
  }, [load]);
  return (
    <section className="zm-config-form zm-execution-detail" aria-label="固定版本评审意见">
      <div className="zm-page-heading">
        <h3>本轮意见</h3>
        <Button busy={reading.kind === 'loading'} onClick={() => void load()}>
          刷新意见
        </Button>
      </div>
      {reading.kind === 'loading' ? (
        <p role="status">正在读取固定版本和意见…</p>
      ) : reading.kind === 'error' ? (
        <p className="zm-error" role="alert">
          本轮意见暂不可读，请刷新或重新打开任务。
        </p>
      ) : (
        <>
          <ReviewOutcomePanel api={api} value={reading.value} />
          {reading.value.round.status === 'open' && openControls}
        </>
      )}
    </section>
  );
}

export function ReviewOutcomePanel({
  api,
  value,
}: {
  api: Pick<NativeReviewApi, 'files'>;
  value: ReviewOutcomeView;
}) {
  const { artifact, round, target } = value;
  const names = Object.fromEntries(
    round.ballots.map((ballot) => [ballot.reviewerId, ballot.reviewerName]),
  );
  return (
    <>
      <p role="status">
        {round.status === 'approved'
          ? '评审已通过'
          : round.status === 'changes-requested'
            ? '已退回修改'
            : round.status === 'voided'
              ? '本轮评审已作废'
              : '正在评审'}
        {' · '}第 {artifact.version} 版
      </p>
      <article className="zm-execution-artifact" aria-label="本轮固定提交产物">
        <h3>提交内容 · 第 {artifact.version} 版</h3>
        <div className="zm-execution-text">{artifact.text || '无文字正文'}</div>
        {artifact.links.map((link, index) => {
          let safe = false;
          try {
            const url = new URL(link);
            safe = ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
          } catch {
            /* Unsafe references remain plain text. */
          }
          return (
            <p key={index}>
              {safe ? (
                <a href={link} target="_blank" rel="noopener noreferrer">
                  {link}
                </a>
              ) : (
                link
              )}
            </p>
          );
        })}
        <FileReferences
          api={api}
          files={artifact.files}
          target={{
            taskId: target.taskId,
            planId: target.planId,
            revision: target.revision,
            nodeId: target.nodeId,
            artifactVersionId: artifact.id,
            purpose: 'artifact',
          }}
        />
      </article>
      <ReviewBallots
        ballots={round.ballots.map(({ reviewerId, action, comment }) => ({
          reviewerId,
          action,
          ...(comment === undefined ? {} : { comment }),
        }))}
        names={names}
      />
      {!round.ballots.length && <p className="zm-muted">本轮尚无已提交的评审意见。</p>}
    </>
  );
}
