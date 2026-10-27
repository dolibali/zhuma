import { useEffect, useId, useRef, useState } from 'react';
import { Button } from './Button.js';
import { FileReferences } from '../execution/FileReferences.js';
import {
  ExecutionError,
  executionErrorMessage,
  type ExecutionApi,
} from '../execution/ExecutionApi.js';
import type {
  ProjectArtifactContent,
  ProjectArtifactCursor,
  ProjectArtifactRef,
  ProjectArtifactSummary,
  ProjectArtifactsApi,
} from './project-artifacts-contract.js';

export interface ProjectArtifactsPanelProps {
  readonly spaceId: string;
  readonly projectId: string;
  readonly api: ProjectArtifactsApi;
  readonly filesApi?: Pick<ExecutionApi, 'files'>;
  openTask(id: string): void;
}
const noFiles: Pick<ExecutionApi, 'files'> = Object.freeze({});
const refKey = (ref: ProjectArtifactRef) =>
  JSON.stringify([
    ref.spaceId,
    ref.projectId,
    ref.taskId,
    ref.planId,
    ref.revision,
    ref.nodeId,
    ref.artifactVersionId,
  ]);
const nodeKey = (ref: ProjectArtifactRef) =>
  JSON.stringify([ref.spaceId, ref.projectId, ref.taskId, ref.planId, ref.revision, ref.nodeId]);
const cursorKey = (cursor: ProjectArtifactCursor) =>
  JSON.stringify([cursor.selection, cursor.taskId, cursor.planId, cursor.revision, cursor.offset]);
type Mode = 'refresh' | 'more';
type Page = {
  readonly kind: 'loading' | 'ready' | 'error';
  readonly mode: Mode;
  readonly items: readonly ProjectArtifactSummary[];
  readonly cursor: ProjectArtifactCursor | undefined;
  readonly error: string;
  readonly retry: Mode;
};
const initial = (): Page => ({
  kind: 'loading',
  mode: 'refresh',
  items: [],
  cursor: undefined,
  error: '',
  retry: 'refresh',
});
const invalid = (message: string): never => {
  throw new ExecutionError('validation', message);
};
const invalidates = (error: unknown) =>
  error instanceof ExecutionError &&
  [
    'unauthenticated',
    'untrusted-request',
    'not-found',
    'scope-mismatch',
    'conflict',
    'validation',
  ].includes(error.code);

/** Scope changes remount before a prior row, reply or file action can be used.
 * A owns actor identity; changing its API identity closes this local lifetime. */
export function ProjectArtifactsPanel(props: ProjectArtifactsPanelProps) {
  const owner = useRef({
    api: props.api,
    filesApi: props.filesApi,
    files: props.filesApi?.files,
    spaceId: props.spaceId,
    projectId: props.projectId,
    generation: 0,
  });
  const old = owner.current;
  if (
    old.api !== props.api ||
    old.filesApi !== props.filesApi ||
    old.files !== props.filesApi?.files ||
    old.spaceId !== props.spaceId ||
    old.projectId !== props.projectId
  )
    owner.current = {
      api: props.api,
      filesApi: props.filesApi,
      files: props.filesApi?.files,
      spaceId: props.spaceId,
      projectId: props.projectId,
      generation: old.generation + 1,
    };
  return <OwnedPanel key={owner.current.generation} {...props} />;
}

function OwnedPanel({ api, spaceId, projectId, filesApi, openTask }: ProjectArtifactsPanelProps) {
  const heading = useId(),
    region = useRef<HTMLElement>(null),
    paging = useRef<HTMLDivElement>(null),
    alive = useRef(false),
    active = useRef<AbortController>(),
    [page, setPage] = useState<Page>(initial),
    currentPage = useRef(page),
    [selected, setSelected] = useState<string>();
  const publish = (next: Page) => {
    currentPage.current = next;
    setPage(next);
  };
  function load(mode: Mode) {
    if (!alive.current || active.current) return;
    const before = currentPage.current;
    if (mode === 'more' && !before.cursor) return;
    const request = new AbortController();
    active.current = request;
    const current = () => alive.current && active.current === request && !request.signal.aborted;
    if (mode === 'refresh') setSelected(undefined);
    publish({
      kind: 'loading',
      mode,
      items: mode === 'more' ? before.items : [],
      cursor: mode === 'more' ? before.cursor : undefined,
      error: '',
      retry: mode,
    });
    void Promise.resolve()
      .then(() => {
        if (!current()) throw new DOMException('aborted', 'AbortError');
        return api.list(
          {
            spaceId,
            projectId,
            limit: 20,
            ...(mode === 'more' && before.cursor ? { cursor: before.cursor } : {}),
          },
          request.signal,
        );
      })
      .then((value) => {
        if (!current()) return;
        if (
          value.view !== 'list' ||
          value.coverage !== 'latest-confirmed-plans' ||
          value.spaceId !== spaceId ||
          value.projectId !== projectId ||
          value.items.length > 20 ||
          value.items.some(
            (item) => item.ref.spaceId !== spaceId || item.ref.projectId !== projectId,
          )
        )
          invalid('成果列表与当前项目不一致，请刷新。');
        if (new Set(value.items.map((item) => refKey(item.ref))).size !== value.items.length)
          invalid('成果列表包含重复版本，请刷新。');
        if (
          mode === 'more' &&
          value.nextCursor &&
          before.cursor &&
          cursorKey(value.nextCursor) === cursorKey(before.cursor)
        )
          throw new ExecutionError('conflict', '成果分页已变化，请刷新后查看。');
        const items = mode === 'more' ? [...before.items] : [];
        for (const item of value.items) {
          const prior = items.find((row) => nodeKey(row.ref) === nodeKey(item.ref));
          if (prior) {
            if (refKey(prior.ref) !== refKey(item.ref) || prior.version !== item.version)
              throw new ExecutionError('conflict', '成果版本已变化，请刷新后查看。');
            continue;
          }
          items.push({ ...item, ref: { ...item.ref } });
        }
        publish({
          kind: 'ready',
          mode,
          items,
          cursor: value.nextCursor ? { ...value.nextCursor } : undefined,
          error: '',
          retry: mode,
        });
      })
      .catch((error: unknown) => {
        if (!current()) return;
        const revoked = invalidates(error);
        if (revoked) setSelected(undefined);
        publish({
          kind: 'error',
          mode,
          items: mode === 'more' && !revoked ? before.items : [],
          cursor: mode === 'more' && !revoked ? before.cursor : undefined,
          error: executionErrorMessage(error),
          retry: revoked ? 'refresh' : mode,
        });
      })
      .finally(() => {
        if (current()) active.current = undefined;
      });
  }
  useEffect(() => {
    alive.current = true;
    load('refresh');
    return () => {
      alive.current = false;
      active.current?.abort();
      active.current = undefined;
    };
  }, []);
  const refresh = () => {
    load('refresh');
    // The retry control may disappear and the refresh button becomes disabled.
    region.current?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
  };
  const busy = page.kind === 'loading';
  return (
    <section className="zm-panel zm-project-panel" aria-labelledby={heading} ref={region}>
      <header className="zm-file-row">
        <h2 id={heading} tabIndex={-1}>
          已接受成果
        </h2>
        <Button variant="quiet" data-project-artifact-refresh disabled={busy} onClick={refresh}>
          刷新
        </Button>
      </header>
      <p className="zm-muted">各任务最新确认计划中的成果</p>
      {busy && !page.items.length && (
        <p className="zm-muted" role="status">
          正在读取成果…
        </p>
      )}
      {page.error && (
        <p className="zm-error" role="alert">
          {page.error}
        </p>
      )}
      {!!page.items.length && (
        <ul className="zm-file-list" aria-label="已接受成果列表">
          {page.items.map((item) => {
            const key = refKey(item.ref);
            return (
              <ArtifactRow
                key={key}
                item={item}
                api={api}
                filesApi={filesApi}
                open={selected === key}
                refresh={refresh}
                toggle={() => setSelected((value) => (value === key ? undefined : key))}
                openTask={() => {
                  if (alive.current) openTask(item.ref.taskId);
                }}
              />
            );
          })}
        </ul>
      )}
      {page.kind === 'ready' && !page.items.length && (
        <p className="zm-muted">
          {page.cursor
            ? '本页暂未找到已接受成果，可继续查找。'
            : '当前最新确认计划暂无已接受成果。'}
        </p>
      )}
      <div
        className="zm-file-actions"
        ref={paging}
        tabIndex={-1}
        role="group"
        aria-label="成果分页"
      >
        {(page.cursor || page.kind === 'error') && (
          <Button
            variant="secondary"
            busy={busy && page.mode === 'more'}
            busyLabel="加载中…"
            disabled={busy}
            onClick={() => {
              const mode = page.kind === 'error' ? page.retry : 'more';
              if (mode === 'refresh') refresh();
              else {
                load(mode);
                paging.current?.focus({ preventScroll: true });
              }
            }}
          >
            {page.kind === 'error'
              ? page.retry === 'more'
                ? '重试加载'
                : '重新读取成果'
              : page.items.length
                ? '加载更多'
                : '继续查找'}
          </Button>
        )}
        {!!page.items.length && <span className="zm-muted">已显示 {page.items.length} 项</span>}
      </div>
    </section>
  );
}

function ArtifactRow({
  item,
  api,
  filesApi,
  open,
  toggle,
  openTask,
  refresh,
}: {
  item: ProjectArtifactSummary;
  api: ProjectArtifactsApi;
  filesApi: Pick<ExecutionApi, 'files'> | undefined;
  open: boolean;
  toggle(): void;
  openTask(): void;
  refresh(): void;
}) {
  const contentId = useId();
  return (
    <li>
      <div className="zm-file-row">
        <div className="zm-file-name">
          <strong>{item.nodeTitle}</strong>
          <small>
            {item.taskTitle} · 计划 v{item.ref.revision} · 已接受 v{item.version}
            {item.fileCount > 0 && ` · ${item.fileCount} 个文件`}
            {item.linkCount > 0 && ` · ${item.linkCount} 个链接`}
          </small>
        </div>
        <div className="zm-file-actions">
          <Button variant="quiet" onClick={openTask} aria-label={`查看任务 ${item.taskTitle}`}>
            查看任务
          </Button>
          <Button
            onClick={toggle}
            aria-expanded={open}
            aria-controls={open ? contentId : undefined}
            aria-label={`${open ? '收起' : '查看'}${item.nodeTitle}已接受 v${item.version} 成果`}
          >
            {open ? '收起' : '查看成果'}
          </Button>
        </div>
      </div>
      {open && (
        <ContentRead item={item} api={api} filesApi={filesApi} id={contentId} refresh={refresh} />
      )}
    </li>
  );
}

function ContentRead({
  item,
  api,
  filesApi,
  id,
  refresh,
}: {
  item: ProjectArtifactSummary;
  api: ProjectArtifactsApi;
  id: string;
  refresh(): void;
  filesApi: Pick<ExecutionApi, 'files'> | undefined;
}) {
  const [reading, setReading] = useState<
    | { kind: 'loading' }
    | { kind: 'ready'; value: ProjectArtifactContent }
    | { kind: 'error'; message: string; stale: boolean }
  >({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const request = new AbortController();
    let alive = true;
    const current = () => alive && !request.signal.aborted;
    setReading({ kind: 'loading' });
    void Promise.resolve()
      .then(() => {
        if (!current()) throw new DOMException('aborted', 'AbortError');
        return api.content({ ...item.ref }, request.signal);
      })
      .then((value) => {
        if (!current()) return;
        if (
          value.view !== 'content' ||
          refKey(value.ref) !== refKey(item.ref) ||
          value.version !== item.version
        )
          invalid('返回的成果与所选版本不一致，请刷新。');
        setReading({
          kind: 'ready',
          value: {
            ...value,
            ref: { ...value.ref },
            content: {
              ...(value.content.text === undefined ? {} : { text: value.content.text }),
              links: [...value.content.links],
              files: value.content.files.map((file) => ({ ...file })),
            },
          },
        });
      })
      .catch((error: unknown) => {
        if (current())
          setReading({
            kind: 'error',
            message: executionErrorMessage(error),
            stale: invalidates(error),
          });
      });
    return () => {
      alive = false;
      request.abort();
    };
  }, [api, attempt, item]);
  return (
    <div
      id={id}
      className="zm-upstream-content"
      role="region"
      aria-label={`${item.nodeTitle}已接受 v${item.version} 内容`}
    >
      {reading.kind === 'loading' ? (
        <p className="zm-muted" role="status">
          正在读取此版本…
        </p>
      ) : reading.kind === 'error' ? (
        <>
          <p className="zm-error" role="alert">
            {reading.message}
          </p>
          <Button
            variant="quiet"
            onClick={() => (reading.stale ? refresh() : setAttempt((value) => value + 1))}
          >
            {reading.stale ? '刷新成果' : '重试读取'}
          </Button>
        </>
      ) : (
        <>
          {!!reading.value.content.text && (
            <div
              className="zm-upstream-body zm-execution-text"
              tabIndex={0}
              role="region"
              aria-label="成果正文"
            >
              {reading.value.content.text}
            </div>
          )}
          {!!reading.value.content.links.length && (
            <ul className="zm-upstream-links" aria-label="参考链接">
              {reading.value.content.links.map((link, index) => {
                let safe = false;
                try {
                  const url = new URL(link);
                  safe =
                    ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
                } catch {
                  /* Unsafe references remain plain text. */
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
          <FileReferences
            api={filesApi ?? noFiles}
            files={reading.value.content.files}
            target={{
              purpose: 'accepted',
              projectId: item.ref.projectId,
              taskId: item.ref.taskId,
              planId: item.ref.planId,
              revision: item.ref.revision,
              nodeId: item.ref.nodeId,
              artifactVersionId: item.ref.artifactVersionId,
            }}
          />
        </>
      )}
    </div>
  );
}
