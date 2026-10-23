import { useState } from 'react';
import { Button } from '../workbench/Button.js';
import type { RevisionContentWire, RevisionViewWire } from './ExecutionApi.js';

function Content({ content }: { content: RevisionContentWire }) {
  return (
    <>
      <p>{content.text || '这一版没有文字说明。'}</p>
      {content.links.map((link) => (
        <p key={link}>
          <a href={link}>{link}</a>
        </p>
      ))}
      {content.files.map((file) => (
        <p key={file.id}>
          {file.id} · {file.mediaType} · {file.byteSize} 字节
        </p>
      ))}
    </>
  );
}

/** The version under review, each return note, and the version before it. */
export function RevisionPanel({
  view,
  pending = false,
  error = '',
}: {
  view?: RevisionViewWire;
  pending?: boolean;
  error?: string;
}) {
  const [previous, setPrevious] = useState(false);
  function locate(event: { preventDefault(): void }) {
    event.preventDefault();
    setPrevious(false);
    requestAnimationFrame(() => {
      const target = document.getElementById('revision-reviewed');
      target?.scrollIntoView({ block: 'start' });
      target?.focus();
    });
  }
  if (error) {
    return (
      <div role="alert" className="zm-error">
        {error}
      </div>
    );
  }
  if (!view) return <p className="zm-empty">{pending ? '正在读取退回意见…' : ''}</p>;
  const reviewed = view.reviewed;
  const earlier = view.previous;
  const showingEarlier = previous && earlier !== undefined;
  return (
    <section className="zm-config-form" aria-labelledby="zhuma-revision-title">
      <div className="zm-page-heading">
        <div>
          <p className="zm-eyebrow">退回</p>
          <h2 id="zhuma-revision-title">对照意见修改</h2>
        </div>
        {earlier ? (
          <Button
            variant="quiet"
            aria-pressed={showingEarlier}
            onClick={() => setPrevious((value) => !value)}
          >
            {showingEarlier ? '返回被评审版本' : '查看上一版'}
          </Button>
        ) : (
          <p className="zm-empty">没有更早的版本。</p>
        )}
      </div>
      <article
        className="zm-review"
        id="revision-reviewed"
        tabIndex={-1}
        hidden={showingEarlier || undefined}
      >
        <h3>被评审的版本{reviewed ? ` · 第 ${reviewed.version} 版` : ''}</h3>
        {reviewed ? <Content content={reviewed} /> : <p>找不到被评审的那一版。</p>}
      </article>
      {earlier && (
        <article
          className="zm-review"
          id="revision-previous"
          hidden={showingEarlier ? undefined : true}
        >
          <h3>上一版 · 第 {earlier.version} 版</h3>
          <Content content={earlier} />
        </article>
      )}
      <h3>退回意见</h3>
      {!view.notes.length && <p className="zm-empty">这次退回没有留下意见。</p>}
      {view.notes.map((note) => (
        <article className="zm-review" key={note.id} id={note.id}>
          <h3>{note.reviewerName}</h3>
          <p>
            <span className="zm-kind">总体意见</span>
          </p>
          <p>{note.body || '没有填写总体意见。'}</p>
          {note.citedCommentIds.map((id) => (
            <p key={id}>
              <a href="#revision-reviewed" onClick={locate}>
                定位评论 {id}
              </a>
            </p>
          ))}
          <p>
            <a href="#revision-reviewed" onClick={locate}>
              定位到对应内容
            </a>
          </p>
        </article>
      ))}
      <p>对照上面的内容逐条修改，再在下方提交新版本。已经评审过的版本不会被改写。</p>
    </section>
  );
}
