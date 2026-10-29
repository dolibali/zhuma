import { useEffect, useId, useRef, useState } from 'react';
import {
  canonicalPayload,
  KNOWLEDGE_LIMITS,
  type KnowledgeProjectLink,
  type KnowledgeProjectLinksValue,
  type KnowledgeSaveProjectLinksRequest,
  type KnowledgePageSummary,
  type KnowledgeReadValue,
  type KnowledgeVersionRef,
} from '@zhuma/agent-core';
import { Button } from '../workbench/Button.js';
import { SingleSelect } from '../workbench/SingleSelect.js';
import { Modal } from '../workbench/controls.js';
import { useUnsavedChanges } from '../workbench/UnsavedChanges.js';
import { KnowledgeClientError } from './api.js';
import type { ProjectKnowledgePanelProps } from './project-knowledge-api.js';

type Ticket = { controller: AbortController; signal: AbortSignal };
type Baseline = { version: number; links: KnowledgeProjectLink[] };
type Preview = {
  reference: KnowledgeVersionRef;
  title: string;
  text: string;
  nextOffset: number;
  totalBytes: number;
};
const pageKey = (ref: KnowledgeVersionRef) =>
  canonicalPayload([ref.spaceId, ref.libraryId, ref.pageId]);
const same = (a: unknown, b: unknown) => canonicalPayload(a) === canonicalPayload(b);
const message = (error: unknown) =>
  error instanceof KnowledgeClientError ? error.message : '操作尚未确认，请重试。';

/** Only this presentation leaf is E-owned. API, routing, scope and styles remain A-owned. */
export function ProjectKnowledgePanel(props: ProjectKnowledgePanelProps) {
  const owner = useRef({
    api: props.api,
    scope: { ...props.scope },
    isCurrent: props.isCurrent,
    epoch: 0,
  });
  const previous = owner.current;
  if (previous.api !== props.api || !same(previous.scope, props.scope) || !previous.isCurrent())
    owner.current = {
      api: props.api,
      scope: { ...props.scope },
      isCurrent: props.isCurrent,
      epoch: previous.epoch + 1,
    };
  else previous.isCurrent = props.isCurrent;
  const current = owner.current;
  if (!props.isCurrent()) return <p role="status">当前项目已不可用，请重新打开。</p>;
  return <OwnedPanel key={current.epoch} {...props} owns={() => owner.current === current} />;
}

function OwnedPanel({
  api,
  scope,
  isCurrent,
  onDirtyChange,
  owns,
}: ProjectKnowledgePanelProps & { owns(): boolean }) {
  const heading = useId(),
    selector = useId();
  const latest = useRef({ isCurrent, onDirtyChange, owns });
  latest.current = { isCurrent, onDirtyChange, owns };
  const alive = useRef(false),
    requests = useRef<{ form?: Ticket; preview?: Ticket }>({});
  const [loaded, setLoaded] = useState<KnowledgeProjectLinksValue>();
  const [catalog, setCatalog] = useState<KnowledgePageSummary[]>([]);
  const [baseline, setBaseline] = useState<Baseline>();
  const [draft, setDraft] = useState<KnowledgeProjectLink[]>([]);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(true),
    busyRef = useRef(false);
  const [unknown, setUnknown] = useState(false),
    pending = useRef<KnowledgeSaveProjectLinksRequest>();
  const [conflict, setConflict] = useState(false),
    [denied, setDenied] = useState(false);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [preview, setPreview] = useState<Preview>(),
    [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState(''),
    [confirmReload, setConfirmReload] = useState(false);
  const dirty =
    !denied && (!!pending.current || conflict || (!!baseline && !same(draft, baseline.links)));
  useUnsavedChanges(dirty);
  useEffect(() => {
    latest.current.onDirtyChange(dirty);
  }, [dirty]);
  useEffect(() => () => latest.current.onDirtyChange(false), []);

  function setWorking(value: boolean) {
    busyRef.current = value;
    setBusy(value);
  }
  function start(lane: 'form' | 'preview'): Ticket {
    requests.current[lane]?.controller.abort();
    const controller = new AbortController();
    const ticket = {
      controller,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
    };
    requests.current[lane] = ticket;
    return ticket;
  }
  function current(ticket: Ticket, lane: 'form' | 'preview') {
    return (
      alive.current &&
      latest.current.owns() &&
      latest.current.isCurrent() &&
      requests.current[lane] === ticket
    );
  }
  function check(ticket: Ticket, lane: 'form' | 'preview' = 'form') {
    if (!current(ticket, lane)) throw new DOMException('Project changed', 'AbortError');
    ticket.signal.throwIfAborted();
  }
  function echo(value: { actorId: string; spaceId: string; projectId?: string }) {
    if (
      value.actorId !== scope.actorId ||
      value.spaceId !== scope.spaceId ||
      (value.projectId !== undefined && value.projectId !== scope.projectId)
    )
      throw new KnowledgeClientError('invalid-response');
  }
  function failed(cause: unknown) {
    if (
      cause instanceof KnowledgeClientError &&
      ['unauthenticated', 'forbidden'].includes(cause.code)
    )
      setDenied(true);
    setError(message(cause));
  }
  function clearPreview() {
    requests.current.preview?.controller.abort();
    delete requests.current.preview;
    setPreview(undefined);
    setPreviewError('');
    setPreviewBusy(false);
  }
  async function reload() {
    if (busyRef.current || pending.current) return;
    const ticket = start('form');
    setWorking(true);
    setError('');
    setNotice('');
    try {
      check(ticket);
      const value = await api.projectLinks(
        { spaceId: scope.spaceId, projectId: scope.projectId },
        ticket.signal,
      );
      check(ticket);
      echo(value);
      const libraries = await api.libraries({ spaceId: scope.spaceId }, ticket.signal);
      check(ticket);
      echo(libraries);
      const pages: KnowledgePageSummary[] = [];
      for (const library of libraries.libraries) {
        if (library.spaceId !== scope.spaceId) throw new KnowledgeClientError('invalid-response');
        let cursor: string | undefined;
        const cursors = new Set<string>();
        for (let page = 0; page < 5; page++) {
          const reply = await api.list(
            {
              spaceId: scope.spaceId,
              libraryId: library.id,
              limit: 50,
              ...(cursor ? { cursor } : {}),
            },
            ticket.signal,
          );
          check(ticket);
          echo(reply);
          if (
            reply.libraryId !== library.id ||
            reply.pages.some(
              (item) =>
                item.reference.spaceId !== scope.spaceId || item.reference.libraryId !== library.id,
            )
          )
            throw new KnowledgeClientError('invalid-response');
          pages.push(...reply.pages);
          if (pages.length > KNOWLEDGE_LIMITS.pagesPerLibrary * KNOWLEDGE_LIMITS.librariesPerSpace)
            throw new KnowledgeClientError('limit');
          if (reply.nextCursor === null) break;
          if (cursors.has(reply.nextCursor) || page === 4)
            throw new KnowledgeClientError('invalid-response');
          cursors.add(reply.nextCursor);
          cursor = reply.nextCursor;
        }
      }
      if (new Set(pages.map((item) => pageKey(item.reference))).size !== pages.length)
        throw new KnowledgeClientError('invalid-response');
      check(ticket);
      setLoaded(value);
      setCatalog(pages);
      const links = structuredClone(value.snapshot.links);
      setBaseline({ version: value.relationshipVersion, links });
      setDraft(structuredClone(links));
      setSelected('');
      setConflict(false);
      setUnknown(false);
      clearPreview();
    } catch (cause) {
      if (current(ticket, 'form')) failed(cause);
    } finally {
      if (current(ticket, 'form')) setWorking(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    void reload();
    return () => {
      alive.current = false;
      requests.current.form?.controller.abort();
      requests.current.preview?.controller.abort();
    };
  }, []);

  const locked = busy || unknown || conflict || denied;
  const available = catalog.filter(
    (page) => !draft.some((link) => pageKey(link.reference) === pageKey(page.reference)),
  );
  function edit(next: KnowledgeProjectLink[]) {
    if (locked || busyRef.current || pending.current) return;
    setDraft(next);
    setNotice('');
    setError('');
  }
  async function save() {
    if (!baseline || busyRef.current || denied || conflict) return;
    if (!pending.current)
      pending.current = {
        spaceId: scope.spaceId,
        projectId: scope.projectId,
        expectedVersion: baseline.version,
        idempotencyKey: crypto.randomUUID(),
        links: structuredClone(draft),
      };
    const intent = pending.current,
      ticket = start('form');
    setWorking(true);
    setError('');
    setNotice('');
    let acknowledged = false;
    try {
      check(ticket);
      const receipt = await api.saveProjectLinks(intent, ticket.signal);
      check(ticket);
      echo(receipt);
      if (receipt.relationshipVersion !== intent.expectedVersion + 1)
        throw new KnowledgeClientError('invalid-response');
      acknowledged = true;
      pending.current = undefined;
      setUnknown(false);
      setBaseline({ version: receipt.relationshipVersion, links: structuredClone(intent.links) });
      setNotice('项目知识关联已保存。');
      const value = await api.projectLinks(
        { spaceId: scope.spaceId, projectId: scope.projectId },
        ticket.signal,
      );
      check(ticket);
      echo(value);
      if (!same(value.snapshot.links, intent.links)) {
        setConflict(true);
        setError('保存已确认，但关联随后有更新。你的选择已保留，请载入已保存关联后核对。');
        return;
      }
      setLoaded(value);
      setBaseline({
        version: value.relationshipVersion,
        links: structuredClone(value.snapshot.links),
      });
      setDraft(structuredClone(value.snapshot.links));
    } catch (cause) {
      if (current(ticket, 'form')) {
        if (
          cause instanceof KnowledgeClientError &&
          ['unauthenticated', 'forbidden'].includes(cause.code)
        )
          setDenied(true);
        const definitive =
          cause instanceof KnowledgeClientError &&
          ['invalid', 'not-found', 'conflict', 'limit', 'forbidden', 'unauthenticated'].includes(
            cause.code,
          );
        if (!acknowledged && !definitive) setUnknown(true);
        else if (!acknowledged) {
          pending.current = undefined;
          setUnknown(false);
        }
        if (cause instanceof KnowledgeClientError && cause.code === 'conflict') {
          setConflict(true);
          setError('关联已更新。你的选择已保留；载入已保存关联后再决定。');
        } else if (acknowledged) setError('保存已确认，列表暂未刷新，请稍后重新读取。');
        else failed(cause);
      }
    } finally {
      if (current(ticket, 'form')) setWorking(false);
    }
  }
  async function read(reference: KnowledgeVersionRef, more = false) {
    const ticket = start('preview');
    setPreviewBusy(true);
    setPreviewError('');
    const previous = more && preview && same(preview.reference, reference) ? preview : undefined;
    if (!previous) setPreview(undefined);
    try {
      check(ticket, 'preview');
      const value: KnowledgeReadValue = await api.read(
        {
          ...reference,
          part: 'body',
          offset: previous?.nextOffset ?? 0,
          length: KNOWLEDGE_LIMITS.readBytes,
        },
        ticket.signal,
      );
      check(ticket, 'preview');
      echo(value);
      if (
        !same(value.reference, reference) ||
        value.part !== 'body' ||
        value.offset !== (previous?.nextOffset ?? 0) ||
        value.nextOffset !== value.offset + value.length ||
        value.nextOffset > value.totalBytes ||
        utf8Bytes(value.text) !== value.length ||
        value.partChecksum !== reference.checksum ||
        (value.length === 0 && value.nextOffset < value.totalBytes) ||
        value.totalBytes > KNOWLEDGE_LIMITS.bodyBytes ||
        (previous && value.totalBytes !== previous.totalBytes)
      )
        throw new KnowledgeClientError('invalid-response');
      setPreview({
        reference,
        title: value.title,
        text: (previous?.text ?? '') + value.text,
        nextOffset: value.nextOffset,
        totalBytes: value.totalBytes,
      });
    } catch (cause) {
      if (current(ticket, 'preview')) {
        if (
          cause instanceof KnowledgeClientError &&
          ['unauthenticated', 'forbidden'].includes(cause.code)
        )
          setDenied(true);
        setPreviewError(message(cause));
      }
    } finally {
      if (current(ticket, 'preview')) setPreviewBusy(false);
    }
  }
  if (denied)
    return (
      <p className="zm-error" role="alert">
        当前账号或空间已不可访问，请重新打开项目。
      </p>
    );
  return (
    <section className="zm-project-knowledge" aria-labelledby={heading}>
      <header className="zm-project-knowledge__header">
        <div>
          <h3 id={heading}>项目知识</h3>
          <p className="zm-muted">为后续执行关联固定版本的资料。</p>
        </div>
        <Button
          variant="quiet"
          disabled={busy || unknown}
          onClick={() => (dirty ? setConfirmReload(true) : void reload())}
        >
          载入已保存关联
        </Button>
      </header>
      {error && (
        <p className="zm-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {!loaded ? (
        <p role="status">{busy ? '正在读取项目知识…' : '项目知识暂不可用，可重新载入。'}</p>
      ) : (
        <>
          {!draft.length ? (
            <p className="zm-muted">还没有关联资料。选择已发布的知识开始。</p>
          ) : (
            <ul className="zm-project-knowledge__list" aria-label="已关联知识">
              {draft.map((link, index) => {
                const saved = loaded.links.find((item) => same(item.reference, link.reference));
                const latestPage = catalog.find(
                  (item) => pageKey(item.reference) === pageKey(link.reference),
                );
                const exact =
                  latestPage && same(latestPage.reference, link.reference) ? latestPage : undefined;
                const title = saved?.title ?? exact?.title ?? link.reference.pageId;
                return (
                  <li className="zm-project-knowledge__row" key={pageKey(link.reference)}>
                    <div className="zm-project-knowledge__identity">
                      <strong>{title}</strong>
                      <span className="zm-muted">
                        v{link.reference.version} · {link.required ? '必读' : '可选'}
                      </span>
                    </div>
                    <div className="zm-project-knowledge__actions">
                      <label>
                        <input
                          type="checkbox"
                          checked={link.required}
                          disabled={locked}
                          aria-label={`${title}执行前必读`}
                          onChange={(event) =>
                            edit(
                              draft.map((item, at) =>
                                at === index ? { ...item, required: event.target.checked } : item,
                              ),
                            )
                          }
                        />
                        执行前必读
                      </label>
                      <Button
                        variant="quiet"
                        disabled={previewBusy}
                        onClick={() => void read(link.reference)}
                      >
                        预览
                      </Button>
                      {latestPage && latestPage.reference.version > link.reference.version && (
                        <Button
                          variant="quiet"
                          disabled={locked}
                          onClick={() => {
                            clearPreview();
                            edit(
                              draft.map((item, at) =>
                                at === index ? { ...item, reference: latestPage.reference } : item,
                              ),
                            );
                          }}
                        >
                          更新到 v{latestPage.reference.version}
                        </Button>
                      )}
                      <Button
                        variant="quiet"
                        disabled={locked}
                        aria-label={`移除${title}关联`}
                        onClick={() => {
                          clearPreview();
                          edit(draft.filter((_, at) => at !== index));
                        }}
                      >
                        移除
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="zm-project-knowledge__picker">
            <label htmlFor={selector}>关联知识</label>
            <SingleSelect
              id={selector}
              label="选择已发布知识"
              value={selected}
              disabled={
                locked || !available.length || draft.length >= KNOWLEDGE_LIMITS.projectLinks
              }
              options={available.map((page) => ({
                value: pageKey(page.reference),
                label: `${page.title} · v${page.reference.version}`,
              }))}
              onValueChange={setSelected}
            />
            <Button
              disabled={locked || !selected || draft.length >= KNOWLEDGE_LIMITS.projectLinks}
              onClick={() => {
                const page = available.find((item) => pageKey(item.reference) === selected);
                if (page) {
                  edit([...draft, { reference: page.reference, required: false }]);
                  setSelected('');
                }
              }}
            >
              关联资料
            </Button>
          </div>
          {!available.length && <p className="zm-muted">暂无其他可关联的已发布知识。</p>}
          {unknown && <p role="status">保存结果尚未确认，请使用原请求重试。</p>}
          <div className="zm-actions">
            <Button
              variant="primary"
              busy={busy}
              disabled={!dirty || conflict}
              onClick={() => void save()}
            >
              {unknown ? '重试保存' : '保存关联'}
            </Button>
          </div>
          {(preview || previewBusy || previewError) && (
            <section className="zm-project-knowledge__preview" aria-label="固定知识预览">
              <header>
                <h4>
                  {preview ? `${preview.title} · v${preview.reference.version}` : '固定知识预览'}
                </h4>
                <Button variant="quiet" onClick={clearPreview}>
                  关闭预览
                </Button>
              </header>
              {previewError && (
                <p className="zm-error" role="alert">
                  {previewError}
                </p>
              )}
              {preview && <pre className="zm-execution-text">{preview.text}</pre>}
              {previewBusy ? (
                <p role="status">正在读取固定版本…</p>
              ) : (
                preview &&
                preview.nextOffset < preview.totalBytes && (
                  <Button onClick={() => void read(preview.reference, true)}>继续读取</Button>
                )
              )}
            </section>
          )}
        </>
      )}
      {confirmReload && (
        <Modal
          variant="confirmation"
          title="载入已保存关联？"
          close={() => setConfirmReload(false)}
        >
          <p>当前未保存的选择会被替换。</p>
          <div className="zm-actions">
            <Button onClick={() => setConfirmReload(false)}>保留选择</Button>
            <Button
              variant="primary"
              onClick={() => {
                setConfirmReload(false);
                void reload();
              }}
            >
              载入已保存关联
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}

const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;
