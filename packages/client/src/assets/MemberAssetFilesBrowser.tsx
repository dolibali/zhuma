import { useEffect, useRef, useState } from 'react';
import {
  MemberAssetFolderCreateSchema,
  type MemberAssetCommand,
  type MemberAssetFolderCreate,
  type MemberAssetFolderListValue,
  type MemberAssetReadValue,
} from '@zhuma/agent-core';
import type { MemberSpaceLifetime } from '../identity/MemberSpaceBoundary.js';
import { Button } from '../workbench/Button.js';
import { Field, Modal } from '../workbench/controls.js';
import { useLeaveConfirmation } from '../workbench/useLeaveConfirmation.js';
import { useUnsavedChanges } from '../workbench/UnsavedChanges.js';
import { MemberAssetClientError, type MemberAssetApi, type MemberAssetFileContent } from './api.js';
import { MemberAssetFilePreview } from './MemberAssetFilePreview.js';

type Asset = MemberAssetReadValue['asset'];
type FolderId = string | null;
const message = (error: unknown) =>
  error instanceof MemberAssetClientError ? error.message : '暂时无法读取资料，请重试。';
const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** Folder and file metadata come from the original member registry. Opening a
 * directory never reads bodies or fabricates sizes/draft modification times. */
export function MemberAssetFilesBrowser({
  api,
  spaceId,
  lifetime,
  folderId,
  onFolderChange,
  refresh,
  onUpload,
  onDetails,
  onOpenKnowledge,
}: {
  api: MemberAssetApi;
  spaceId: string;
  lifetime: MemberSpaceLifetime;
  folderId: FolderId;
  onFolderChange(folderId: FolderId): void;
  refresh: number;
  onUpload(): void;
  onDetails(asset: Asset): void;
  onOpenKnowledge?: (() => void) | undefined;
}) {
  const [view, setView] = useState<MemberAssetFolderListValue>(),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [search, setSearch] = useState(''),
    [revision, setRevision] = useState(0),
    [reading, setReading] = useState(''),
    [write, setWrite] = useState<{ kind: 'create' } | { kind: 'move'; asset: Asset }>(),
    [knownSizes, setKnownSizes] = useState<Record<string, number>>({});
  const [preview, setPreview] = useState<{
    file: NonNullable<MemberAssetReadValue['file']>;
    content: MemberAssetFileContent;
  }>();
  const alive = useRef(false),
    read = useRef<AbortController>(),
    currentFolder = useRef(folderId),
    currentLifetime = useRef(lifetime);
  currentFolder.current = folderId;
  currentLifetime.current = lifetime;
  useEffect(() => {
    alive.current = true;
    setKnownSizes({});
    return () => {
      alive.current = false;
      read.current?.abort();
    };
  }, [api, spaceId]);
  useEffect(() => {
    const stop = new AbortController(),
      signal = AbortSignal.any([stop.signal, AbortSignal.timeout(30000)]);
    read.current?.abort();
    setReading('');
    setPreview(undefined);
    setLoading(true);
    setError('');
    setView(undefined);
    setSearch('');
    void api
      .listFolder({ spaceId, folderId, includeDrafts: true }, signal)
      .then(
        (value) => {
          if (alive.current && !signal.aborted && currentLifetime.current.isCurrent())
            setView(value);
        },
        (failure) => {
          if (alive.current && !signal.aborted && currentLifetime.current.isCurrent())
            setError(message(failure));
          else if (alive.current && !stop.signal.aborted && currentLifetime.current.isCurrent())
            setError('读取超时，请重试。');
        },
      )
      .finally(() => {
        if (alive.current && !stop.signal.aborted && currentLifetime.current.isCurrent())
          setLoading(false);
      });
    return () => stop.abort();
  }, [api, spaceId, folderId, refresh, revision]);
  async function open(asset: Asset) {
    const version = asset.versions.at(-1);
    if (!version) {
      onDetails(asset);
      return;
    }
    read.current?.abort();
    const operation = new AbortController(),
      selectedFolder = folderId,
      signal = AbortSignal.any([operation.signal, AbortSignal.timeout(125000)]);
    read.current = operation;
    setReading(asset.assetId);
    setError('');
    const current = () => {
      signal.throwIfAborted();
      if (
        !alive.current ||
        read.current !== operation ||
        currentFolder.current !== selectedFolder ||
        !currentLifetime.current.isCurrent()
      )
        throw new DOMException('File view changed', 'AbortError');
    };
    try {
      const detail = await api.read(
        { spaceId, assetId: asset.assetId, versionId: version.reference.versionId },
        signal,
      );
      current();
      if (
        !detail.file ||
        detail.selection.kind !== 'published' ||
        JSON.stringify(detail.selection.reference) !== JSON.stringify(version.reference)
      )
        throw new MemberAssetClientError('invalid-response');
      const content = await api.file(
        {
          spaceId,
          assetId: asset.assetId,
          versionId: version.reference.versionId,
          mode: 'preview',
        },
        detail.file,
        signal,
      );
      current();
      setKnownSizes((values) => ({
        ...values,
        [version.reference.versionId]: detail.file!.byteSize,
      }));
      setPreview({ file: detail.file, content });
    } catch (failure) {
      if (
        alive.current &&
        read.current === operation &&
        currentFolder.current === selectedFolder &&
        currentLifetime.current.isCurrent() &&
        !operation.signal.aborted
      )
        setError(message(failure));
    } finally {
      if (alive.current && read.current === operation && currentLifetime.current.isCurrent())
        setReading('');
    }
  }
  const query = search.trim().normalize('NFKC').toLocaleLowerCase(),
    matches = (name: string) => name.normalize('NFKC').toLocaleLowerCase().includes(query),
    folders = view?.folders.filter((folder) => matches(folder.name)) ?? [],
    files = view?.files.filter((asset) => matches(asset.name)) ?? [];
  return (
    <section className="zm-file-browser" aria-label="资料文件" aria-busy={loading}>
      <header className="zm-file-browser-toolbar">
        <FolderBreadcrumbs value={view} disabled={loading} change={onFolderChange} />
        <div className="zm-actions">
          {onOpenKnowledge && <Button onClick={onOpenKnowledge}>在线文档</Button>}
          <Button disabled={loading} onClick={() => setRevision((value) => value + 1)}>
            刷新
          </Button>
          <Button disabled={loading || !view} onClick={() => setWrite({ kind: 'create' })}>
            新建文件夹
          </Button>
          <Button variant="primary" disabled={loading || !view} onClick={onUpload}>
            上传文件
          </Button>
        </div>
      </header>
      <input
        type="search"
        aria-label="搜索当前文件夹"
        placeholder="搜索当前文件夹…"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {error && (
        <div className="zm-error" role="alert">
          {error}
          {!view && <Button onClick={() => setRevision((value) => value + 1)}>重试</Button>}
        </div>
      )}
      {loading ? (
        <p role="status">正在读取文件夹…</p>
      ) : (
        view && (
          <div className="zm-file-browser-table-wrap">
            <table className="zm-file-browser-table">
              <thead>
                <tr>
                  <th scope="col">名称</th>
                  <th scope="col">大小</th>
                  <th scope="col">状态 / 版本</th>
                  <th scope="col">发布日期</th>
                  <th scope="col">
                    <span className="zm-file-actions-label">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {folders.map((folder) => (
                  <tr key={folder.folderId}>
                    <td>
                      <button
                        className="zm-file-name"
                        onClick={() => onFolderChange(folder.folderId)}
                      >
                        <FileGlyph folder />
                        <strong>{folder.name}</strong>
                      </button>
                    </td>
                    <td>—</td>
                    <td>文件夹</td>
                    <td>—</td>
                    <td />
                  </tr>
                ))}
                {files.map((asset) => {
                  const version = asset.versions.at(-1),
                    bytes = version && knownSizes[version.reference.versionId];
                  return (
                    <tr key={asset.assetId}>
                      <td>
                        <button
                          className="zm-file-name"
                          disabled={reading === asset.assetId}
                          aria-label={`${version ? '预览文件' : '打开草稿'} ${asset.name}`}
                          onClick={() => void open(asset)}
                        >
                          <FileGlyph />
                          <strong>{asset.name}</strong>
                        </button>
                      </td>
                      <td>{bytes === undefined ? '—' : size(bytes)}</td>
                      <td>
                        {asset.hasDraft
                          ? version
                            ? `有草稿 · v${version.number}`
                            : '草稿'
                          : `v${version?.number ?? ''}`}
                      </td>
                      <td>
                        {version ? (
                          <time dateTime={version.publishedAt}>
                            {new Date(version.publishedAt).toLocaleDateString()}
                          </time>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        <div className="zm-actions">
                          <Button
                            aria-label={`文件信息 ${asset.name}`}
                            variant="quiet"
                            onClick={() => onDetails(asset)}
                          >
                            信息
                          </Button>
                          {asset.canMaintain && (
                            <Button
                              aria-label={`移动文件 ${asset.name}`}
                              variant="quiet"
                              onClick={() => setWrite({ kind: 'move', asset })}
                            >
                              移动
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {!folders.length && !files.length && (
                  <tr>
                    <td colSpan={5}>
                      <div className="zm-empty">
                        <h3>{query ? '没有匹配的文件或文件夹' : '文件夹为空'}</h3>
                        {!query && <Button onClick={onUpload}>上传文件</Button>}
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )
      )}
      {reading && <p role="status">正在打开文件…</p>}
      {preview && <MemberAssetFilePreview value={preview} close={() => setPreview(undefined)} />}
      {write && (
        <FolderWriteDialog
          api={api}
          spaceId={spaceId}
          lifetime={lifetime}
          folderId={folderId}
          mode={write}
          close={() => setWrite(undefined)}
          changed={() => {
            setWrite(undefined);
            setRevision((value) => value + 1);
          }}
        />
      )}
    </section>
  );
}
function FolderBreadcrumbs({
  value,
  disabled,
  change,
}: {
  value: MemberAssetFolderListValue | undefined;
  disabled: boolean;
  change(folderId: FolderId): void;
}) {
  return (
    <nav className="zm-folder-breadcrumbs" aria-label="文件夹位置">
      <Button
        variant="quiet"
        disabled={disabled || value?.folderId === null}
        onClick={() => change(null)}
      >
        全部文件
      </Button>
      {value?.path.map((folder, index) => (
        <span key={folder.folderId}>
          <span aria-hidden="true">/</span>
          <Button
            variant="quiet"
            aria-current={index === value.path.length - 1 ? 'page' : undefined}
            disabled={disabled || index === value.path.length - 1}
            onClick={() => change(folder.folderId)}
          >
            {folder.name}
          </Button>
        </span>
      ))}
    </nav>
  );
}
function FolderWriteDialog({
  api,
  spaceId,
  lifetime,
  folderId,
  mode,
  close,
  changed,
}: {
  api: MemberAssetApi;
  spaceId: string;
  lifetime: MemberSpaceLifetime;
  folderId: FolderId;
  mode: { kind: 'create' } | { kind: 'move'; asset: Asset };
  close(): void;
  changed(): void;
}) {
  const [name, setName] = useState(''),
    [target, setTarget] = useState<FolderId>(folderId),
    [view, setView] = useState<MemberAssetFolderListValue>(),
    [loading, setLoading] = useState(mode.kind === 'move'),
    [busy, setBusy] = useState(false),
    [unknown, setUnknown] = useState(false),
    [error, setError] = useState(''),
    [retry, setRetry] = useState(0),
    [intent, setIntent] = useState<MemberAssetFolderCreate | MemberAssetCommand>();
  const owner = useRef<AbortController>(),
    alive = useRef(true),
    currentLifetime = useRef(lifetime);
  currentLifetime.current = lifetime;
  const leave = useLeaveConfirmation(() => alive.current && currentLifetime.current.isCurrent());
  const dirty = !!name || busy || unknown;
  useUnsavedChanges(dirty);
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    owner.current = controller;
    return () => {
      alive.current = false;
      controller.abort();
    };
  }, [api, spaceId]);
  useEffect(() => {
    if (mode.kind !== 'move') return;
    const stop = new AbortController(),
      signal = AbortSignal.any([stop.signal, AbortSignal.timeout(30000)]);
    setLoading(true);
    setView(undefined);
    setError('');
    void api
      .listFolder({ spaceId, folderId: target, includeDrafts: true }, signal)
      .then(
        (value) => {
          if (!stop.signal.aborted && alive.current && currentLifetime.current.isCurrent())
            setView(value);
        },
        (failure) => {
          if (!stop.signal.aborted && alive.current && currentLifetime.current.isCurrent())
            setError(message(failure));
        },
      )
      .finally(() => {
        if (!stop.signal.aborted && alive.current) setLoading(false);
      });
    return () => stop.abort();
  }, [api, spaceId, target, retry, mode.kind]);
  async function perform() {
    if (busy) return;
    let request = intent;
    if (!request) {
      if (mode.kind === 'create') {
        const parsed = MemberAssetFolderCreateSchema.safeParse({
          spaceId,
          folderId: crypto.randomUUID(),
          parentFolderId: folderId,
          name,
          expectedVersion: 0,
          idempotencyKey: crypto.randomUUID(),
        });
        if (!parsed.success) {
          setError('请输入 1–80 字的文件夹名称。');
          return;
        }
        request = parsed.data;
      } else
        request = {
          operation: 'move-file',
          spaceId,
          assetId: mode.asset.assetId,
          expectedVersion: mode.asset.version,
          idempotencyKey: crypto.randomUUID(),
          folderId: target,
        };
      setIntent(request);
    }
    const signal = AbortSignal.any([owner.current!.signal, AbortSignal.timeout(125000)]);
    setBusy(true);
    setError('');
    try {
      if ('operation' in request) await api.command(request, signal);
      else await api.createFolder(request, signal);
      if (alive.current && currentLifetime.current.isCurrent() && !signal.aborted) changed();
    } catch (failure) {
      if (alive.current && currentLifetime.current.isCurrent()) {
        const uncertain =
          !(failure instanceof MemberAssetClientError) || failure.outcome === 'unknown';
        setUnknown(uncertain);
        if (!uncertain) setIntent(undefined);
        setError(message(failure));
      }
    } finally {
      if (alive.current && currentLifetime.current.isCurrent()) setBusy(false);
    }
  }
  return (
    <>
      <Modal
        title={mode.kind === 'create' ? '新建文件夹' : `移动 ${mode.asset.name}`}
        close={() => leave.request(close, dirty)}
      >
        <div className="zm-form zm-folder-dialog">
          {mode.kind === 'create' ? (
            <Field label="文件夹名称">
              <input
                autoFocus
                maxLength={80}
                disabled={busy || unknown}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
          ) : (
            <>
              <FolderBreadcrumbs
                value={view}
                disabled={busy || unknown || loading}
                change={setTarget}
              />
              {loading ? (
                <p role="status">正在读取文件夹…</p>
              ) : (
                view && (
                  <div className="zm-folder-targets">
                    {view.folders.map((folder) => (
                      <Button
                        key={folder.folderId}
                        disabled={busy || unknown}
                        onClick={() => setTarget(folder.folderId)}
                      >
                        <FileGlyph folder /> {folder.name}
                      </Button>
                    ))}
                    {!view.folders.length && <p>没有子文件夹，可移动到当前位置。</p>}
                  </div>
                )
              )}
            </>
          )}
          {error && (
            <div className="zm-error" role="alert">
              {error}
              {mode.kind === 'move' && !view && !busy && (
                <Button onClick={() => setRetry((value) => value + 1)}>重试</Button>
              )}
            </div>
          )}
          {unknown && <p role="status">结果尚未确认，请重试原请求。</p>}
          <footer className="zm-dialog-actions">
            <Button disabled={busy} onClick={() => leave.request(close, dirty)}>
              取消
            </Button>
            <Button
              variant="primary"
              disabled={
                busy ||
                (!unknown &&
                  (mode.kind === 'create' ? !name.trim() : loading || !view || target === folderId))
              }
              onClick={() => void perform()}
            >
              {busy
                ? '正在保存…'
                : unknown
                  ? '重试原请求'
                  : mode.kind === 'create'
                    ? '创建文件夹'
                    : '移动到这里'}
            </Button>
          </footer>
        </div>
      </Modal>
      {leave.dialog}
    </>
  );
}

/** Same bounded, currentColor stroke treatment as the existing navigation SVGs. */
function FileGlyph({ folder = false }: { folder?: boolean }) {
  return (
    <svg
      className="zm-file-glyph"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {folder ? (
        <path d="M3 7V5h6l2 2h10v12H3Z" />
      ) : (
        <>
          <path d="M6 3h8l4 4v14H6Z M14 3v5h4" />
          <path d="M9 12h6M9 16h6" />
        </>
      )}
    </svg>
  );
}
