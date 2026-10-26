import { FileReferences } from './FileReferences.js';
import { useId, useRef, useState } from 'react';
import { Button } from '../workbench/Button.js';
import { Field } from '../workbench/controls.js';
import { SingleSelect } from '../workbench/SingleSelect.js';
import type {
  ExecutionApi,
  RevisionQuery,
  RevisionContentWire,
  RevisionViewWire,
} from './ExecutionApi.js';

function Content({
  content,
  api,
  target,
}: {
  content: RevisionContentWire;
  api?: ExecutionApi | undefined;
  target?: RevisionQuery | undefined;
}) {
  return (
    <>
      <div className="zm-execution-text">{content.text || '无文字正文'}</div>
      {!!content.links.length && (
        <ul className="zm-revision-links">
          {content.links.map((link, index) => {
            let safe = false;
            try {
              const url = new URL(link);
              safe = ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
            } catch {
              /* Unsafe links remain plain text. */
            }
            return (
              <li key={index}>
                {safe ? (
                  <a href={link} target="_blank" rel="noopener noreferrer">
                    {link}
                  </a>
                ) : (
                  <span>{link}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {api && target ? (
        <FileReferences
          api={api}
          files={content.files}
          target={{ ...target, purpose: 'artifact', artifactVersionId: content.id }}
        />
      ) : (
        !!content.files.length && (
          <div className="zm-revision-files">
            <h4>文件信息</h4>
            <ul>
              {content.files.map((file, index) => (
                <li key={`${file.id}-${index}`}>
                  <strong>{file.id}</strong>
                  <span>
                    {file.mediaType} · {file.byteSize.toLocaleString()} 字节
                  </span>
                </li>
              ))}
            </ul>
            <p className="zm-muted">本次查询未提供文件预览。</p>
          </div>
        )
      )}
    </>
  );
}

/** Read-only #80 projection. Reference ids are not fabricated comment anchors or file previews. */
export function RevisionPanel({
  view,
  pending = false,
  error = '',
  reload,
  api,
  target,
}: {
  api?: ExecutionApi | undefined;
  target?: RevisionQuery | undefined;
  view?: RevisionViewWire | undefined;
  pending?: boolean;
  error?: string;
  reload?(): void;
}) {
  const heading = useId();
  const notesHeading = useId();
  const contentHeading = useId();
  const source = useRef<HTMLElement>(null);
  const [selected, setSelected] = useState<string>();
  const versions = [view?.reviewed, view?.previous].filter(
    (value): value is RevisionContentWire => !!value,
  );
  const content = versions.find((item) => item.id === selected) ?? view?.reviewed;
  function locate(id: string) {
    setSelected(id);
    requestAnimationFrame(() => {
      source.current?.scrollIntoView({ block: 'nearest' });
      source.current?.focus();
    });
  }
  return (
    <section className="zm-config-form zm-execution-detail zm-revision" aria-labelledby={heading}>
      <div className="zm-page-heading">
        <h2 id={heading}>退回意见</h2>
        {reload && (
          <Button variant="quiet" busy={pending} busyLabel="正在读取…" onClick={reload}>
            {error ? '重试读取' : '刷新意见'}
          </Button>
        )}
      </div>
      {pending ? (
        <p role="status">正在读取被退回的版本和意见…</p>
      ) : error ? (
        <div role="alert" className="zm-error">
          {error}
        </div>
      ) : (
        view && (
          <div className="zm-revision-grid">
            <div className="zm-revision-source">
              {!!versions.length && (
                <Field label="对照版本">
                  <SingleSelect
                    label="对照版本"
                    value={content?.id ?? ''}
                    options={versions.map((version) => ({
                      value: version.id,
                      label: `${version.id === view.reviewed?.id ? '被退回' : '上一版'} · 第 ${version.version} 版`,
                    }))}
                    onValueChange={setSelected}
                  />
                </Field>
              )}
              <article
                className="zm-execution-artifact"
                ref={source}
                tabIndex={-1}
                aria-labelledby={contentHeading}
              >
                <h3 id={contentHeading}>
                  {content
                    ? `第 ${content.version} 版 · ${content.id === view.reviewed?.id ? '被退回的版本' : '上一版'}`
                    : '被退回的版本暂不可用'}
                </h3>
                {content ? (
                  <Content content={content} api={api} target={target} />
                ) : (
                  <p className="zm-muted">未返回该版本正文，可刷新意见重试。</p>
                )}
              </article>
              {!view.previous && (
                <p className="zm-muted zm-revision-version-note">未返回上一版。</p>
              )}
            </div>
            <aside className="zm-revision-notes" aria-labelledby={notesHeading}>
              <h3 id={notesHeading}>
                修改意见 <span className="zm-kind">{view.notes.length}</span>
              </h3>
              {!view.notes.length && <p className="zm-empty">这次退回没有留下总体意见。</p>}
              {view.notes.map((note) => {
                const version = versions.find((item) => item.id === note.artifactVersionId);
                return (
                  <article className="zm-revision-note" key={note.id}>
                    <header>
                      <strong>{note.reviewerName}</strong>
                      <span className="zm-kind">
                        {view.reviewed
                          ? note.artifactVersionId === view.reviewed.id
                            ? '本次退回'
                            : '历史退回'
                          : '退回意见'}
                      </span>
                      <span className="zm-muted">
                        {version ? `第 ${version.version} 版` : note.artifactVersionId}
                      </span>
                    </header>
                    <p className="zm-execution-text">{note.body || '未填写总体意见。'}</p>
                    {!!note.citedCommentIds.length && (
                      <div className="zm-revision-references">
                        <span>引用评论</span>
                        {note.citedCommentIds.map((id) => (
                          <code key={id}>{id}</code>
                        ))}
                      </div>
                    )}
                    {version ? (
                      <Button variant="quiet" onClick={() => locate(version.id)}>
                        查看引用版本
                      </Button>
                    ) : (
                      <p className="zm-muted">该版本正文未返回。</p>
                    )}
                  </article>
                );
              })}
            </aside>
          </div>
        )
      )}
    </section>
  );
}
