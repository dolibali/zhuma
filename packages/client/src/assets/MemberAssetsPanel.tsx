import { useEffect, useMemo, useRef, useState } from 'react';
import {
  teamAssetCatalogRowKey,
  type MemberAssetCommand,
  type MemberAssetDefinition,
  type MemberAssetReadValue,
  type MemberAssetLegacySourceValue,
  type TeamAssetCatalogRow,
  type TeamAssetCatalogValue,
  type KnowledgeReadValue,
  type Workbench,
} from '@zhuma/agent-core';
import type { MemberSpaceLifetime } from '../identity/MemberSpaceBoundary.js';
import type { KnowledgeApi } from '../knowledge/api.js';
import { Button } from '../workbench/Button.js';
import { Modal } from '../workbench/controls.js';
import { SingleSelect } from '../workbench/SingleSelect.js';
import { useLeaveConfirmation } from '../workbench/useLeaveConfirmation.js';
import { useUnsavedChanges } from '../workbench/UnsavedChanges.js';
import { MemberAssetDefinitionFields } from '../workbench/MemberAssetDefinitionFields.js';
import { MemberAssetImportDialog } from './MemberAssetImportDialog.js';
import { MemberAssetFilesBrowser } from './MemberAssetFilesBrowser.js';
import { MemberAssetFilesUploadDialog } from './MemberAssetFilesUploadDialog.js';
import { MemberAssetFilePreview } from './MemberAssetFilePreview.js';
import {
  MemberAssetClientError,
  describeMemberAssetFile,
  type MemberAssetApi,
  type MemberAssetFileContent,
} from './api.js';

type Category = TeamAssetCatalogValue['category'];
type Dependencies = MemberAssetReadValue['dependencies'];
type MemberAssetSummary = MemberAssetReadValue['asset'];
type Form = { definition: MemberAssetDefinition; dependencies: Dependencies };
type Detail =
  | { kind: 'new'; assetId: string; form: Form }
  | { kind: 'owned'; value: MemberAssetReadValue; editing: boolean; form: Form }
  | { kind: 'legacy'; value: MemberAssetLegacySourceValue; form: Form }
  | { kind: 'knowledge'; value: KnowledgeReadValue };
type Intent =
  | { kind: 'command'; input: MemberAssetCommand }
  | { kind: 'upload'; input: Parameters<MemberAssetApi['upload']>[0]; file: File };
const categories: readonly [Category, string][] = [
  ['all', '全部'],
  ['material', '资料'],
  ['template', '工作流'],
  ['expert', 'Agent 专家'],
  ['skill', 'Skills'],
];
const labels = { file: '文件', template: '工作流', expert: 'Agent 专家', skill: 'Skill' };
const formKey = (form: Form) => JSON.stringify(form);
const formOf = (value: MemberAssetReadValue | MemberAssetLegacySourceValue): Form => ({
  definition: value.definition,
  dependencies: 'dependencies' in value ? value.dependencies : [],
});
const message = (error: unknown) =>
  error instanceof MemberAssetClientError ? error.message : '暂时无法完成操作，请重试。';
function blank(kind: MemberAssetDefinition['kind']): MemberAssetDefinition {
  const base = { name: '', description: '' };
  if (kind === 'expert') return { ...base, kind, role: '', capabilities: [], instructions: '' };
  if (kind === 'skill' || kind === 'template') return { ...base, kind, content: '' };
  return { ...base, kind: 'file' };
}

/** Normal member UI over authoritative Core projections. It owns only view,
 * editing and retry state; no asset, grant or publication facts are invented. */
export function MemberAssetsPanel({
  api,
  spaceId,
  lifetime,
  authoringState,
  knowledge,
  onOpenKnowledge,
  onDirtyChange,
  onChanged,
}: {
  api: MemberAssetApi;
  spaceId: string;
  lifetime: MemberSpaceLifetime;
  authoringState?: Workbench;
  knowledge?: KnowledgeApi;
  onOpenKnowledge?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onChanged?: () => void;
}) {
  const [folderId, setFolderId] = useState<string | null>(null),
    [uploadTarget, setUploadTarget] = useState<{ folderId: string | null }>();
  const uploadApi = useMemo(
    () => ({
      command(input: MemberAssetCommand, signal: AbortSignal) {
        return api.command(
          input.operation === 'create-draft' && input.definition.kind === 'file' && uploadTarget
            ? { ...input, folderId: uploadTarget.folderId }
            : input,
          signal,
        );
      },
      read: api.read,
      upload: api.upload,
    }),
    [api, uploadTarget],
  );
  const [category, setCategory] = useState<Category>('all'),
    [search, setSearch] = useState(''),
    [offset, setOffset] = useState(0),
    [refresh, setRefresh] = useState(0);
  const [browse, setBrowse] = useState<{
    phase: 'loading' | 'ready' | 'error';
    value?: TeamAssetCatalogValue;
    error?: string;
  }>({ phase: 'loading' });
  const [detail, setDetail] = useState<Detail | null>(null),
    [detailLoading, setDetailLoading] = useState(false),
    [error, setError] = useState('');
  const [choices, setChoices] = useState<
    { reference: Dependencies[number]['reference']; name: string; version: number }[]
  >([]);
  const [skillAssets, setSkillAssets] = useState<MemberAssetSummary[]>([]),
    [importOpen, setImportOpen] = useState(false);
  const [baseline, setBaseline] = useState(''),
    [intent, setIntent] = useState<Intent | null>(null),
    [busy, setBusy] = useState(''),
    [unknown, setUnknown] = useState(false),
    [notice, setNotice] = useState('');
  const [preview, setPreview] = useState<{
    file: NonNullable<MemberAssetReadValue['file']>;
    content: MemberAssetFileContent;
  } | null>(null);
  const lifetimeRef = useRef(lifetime);
  lifetimeRef.current = lifetime;
  const epoch = useRef({ controller: new AbortController() }),
    readAttempt = useRef(0),
    mounted = useRef(false),
    rowRead = useRef<AbortController>();
  const dirty =
    !!busy || unknown || !!(detail && 'form' in detail && formKey(detail.form) !== baseline);
  const leave = useLeaveConfirmation(() => mounted.current && lifetimeRef.current.isCurrent());
  useUnsavedChanges(dirty);
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    mounted.current = true;
    const owner = { controller: new AbortController() };
    epoch.current = owner;
    return () => {
      mounted.current = false;
      owner.controller.abort();
      rowRead.current?.abort();
    };
  }, [api, spaceId]);
  function ticket() {
    const owner = epoch.current;
    return {
      owner,
      signal: AbortSignal.any([owner.controller.signal, AbortSignal.timeout(125_000)]),
    };
  }
  function live(t: ReturnType<typeof ticket>) {
    if (!mounted.current || epoch.current !== t.owner || !lifetimeRef.current.isCurrent())
      throw new DOMException('Asset view changed', 'AbortError');
  }
  function current(t: ReturnType<typeof ticket>) {
    live(t);
    t.signal.throwIfAborted();
  }
  useEffect(() => {
    const t = ticket(),
      stop = new AbortController(),
      signal = AbortSignal.any([t.signal, stop.signal]);
    setBrowse({ phase: 'loading' });
    void api.catalog({ spaceId, category, search, offset, limit: 30 }, signal).then(
      (value) => {
        try {
          current(t);
          signal.throwIfAborted();
          setBrowse({ phase: 'ready', value });
        } catch {}
      },
      (failure) => {
        if (signal.aborted || !mounted.current) return;
        try {
          current(t);
          setBrowse({ phase: 'error', error: message(failure) });
        } catch {}
      },
    );
    return () => stop.abort();
  }, [api, spaceId, category, search, offset, refresh]);
  useEffect(() => {
    const t = ticket(),
      stop = new AbortController(),
      signal = AbortSignal.any([t.signal, stop.signal]);
    setChoices([]);
    void api.list({ spaceId, kind: 'skill', includeDrafts: true }, signal).then(
      (value) => {
        try {
          current(t);
          signal.throwIfAborted();
          setSkillAssets(value.items);
          setChoices(
            value.items.flatMap((asset) =>
              asset.versions.map((version) => ({
                reference: version.reference,
                name: asset.name,
                version: version.number,
              })),
            ),
          );
        } catch {}
      },
      (failure) => {
        if (signal.aborted || !mounted.current) return;
        try {
          current(t);
          setError(message(failure));
        } catch {}
      },
    );
    return () => stop.abort();
  }, [api, spaceId, refresh]);
  function accept(next: Detail) {
    setDetail(next);
    setBaseline('form' in next ? formKey(next.form) : '');
    setError('');
    setNotice('');
    setIntent(null);
    setUnknown(false);
    setPreview(null);
  }
  async function readAsset(asset: MemberAssetSummary, selection?: string) {
    const t = ticket(),
      attempt = ++readAttempt.current;
    rowRead.current?.abort();
    const stop = new AbortController();
    rowRead.current = stop;
    const signal = AbortSignal.any([t.signal, stop.signal]);
    setDetailLoading(true);
    setError('');
    setPreview(null);
    try {
      const version =
        selection ??
        (asset.hasDraft && asset.canMaintain
          ? 'draft'
          : asset.versions.at(-1)?.reference.versionId);
      if (!version) throw new MemberAssetClientError('asset-not-found');
      const value = await api.read(
        version === 'draft'
          ? { spaceId, assetId: asset.assetId, draft: true }
          : { spaceId, assetId: asset.assetId, versionId: version },
        signal,
      );
      current(t);
      signal.throwIfAborted();
      if (attempt !== readAttempt.current) return;
      accept({
        kind: 'owned',
        value,
        editing: value.selection.kind === 'draft',
        form: formOf(value),
      });
    } catch (failure) {
      if (!signal.aborted && attempt === readAttempt.current) {
        try {
          current(t);
          setError(message(failure));
        } catch {}
      }
    } finally {
      if (!signal.aborted && attempt === readAttempt.current) {
        try {
          current(t);
          setDetailLoading(false);
        } catch {}
      }
    }
  }
  async function open(row: TeamAssetCatalogRow) {
    if (row.source === 'asset') return readAsset(row.asset);
    const t = ticket(),
      attempt = ++readAttempt.current;
    rowRead.current?.abort();
    const stop = new AbortController();
    rowRead.current = stop;
    const signal = AbortSignal.any([t.signal, stop.signal]);
    setDetailLoading(true);
    setError('');
    setPreview(null);
    try {
      const next: Detail =
        row.source === 'knowledge'
          ? {
              kind: 'knowledge',
              value: await knowledge!.read({ ...row.page.reference, length: 8192 }, signal),
            }
          : await api
              .source(row.legacy.source, signal)
              .then((value) => ({ kind: 'legacy' as const, value, form: formOf(value) }));
      current(t);
      signal.throwIfAborted();
      if (attempt === readAttempt.current) accept(next);
    } catch (failure) {
      if (!signal.aborted && attempt === readAttempt.current) {
        try {
          current(t);
          setError(message(failure));
        } catch {}
      }
    } finally {
      if (!signal.aborted && attempt === readAttempt.current) {
        try {
          current(t);
          setDetailLoading(false);
        } catch {}
      }
    }
  }
  function create(kind: MemberAssetDefinition['kind']) {
    leave.request(() => {
      ++readAttempt.current;
      rowRead.current?.abort();
      setDetailLoading(false);
      const form = { definition: blank(kind), dependencies: [] };
      accept({ kind: 'new', assetId: crypto.randomUUID(), form });
    }, dirty);
  }
  async function perform(next: Intent) {
    if (busy) return;
    const t = ticket();
    setIntent(next);
    setUnknown(false);
    setError('');
    setBusy(next.kind === 'upload' ? '正在上传文件…' : '正在保存…');
    let acknowledged = false;
    try {
      const receipt =
        next.kind === 'command'
          ? await api.command(next.input, t.signal)
          : await api.upload(next.input, next.file, t.signal);
      current(t);
      acknowledged = true;
      setUnknown(false);
      setRefresh((value) => value + 1);
      onChanged?.();
      const assetId = next.input.assetId;
      const published =
        next.kind === 'command' && next.input.operation === 'publish' && 'reference' in receipt
          ? receipt.reference
          : undefined;
      const value = await api.read(
        published
          ? { spaceId, assetId, versionId: published.versionId }
          : { spaceId, assetId, draft: true },
        t.signal,
      );
      current(t);
      accept({
        kind: 'owned',
        value,
        editing: value.selection.kind === 'draft',
        form: formOf(value),
      });
      setNotice(next.kind === 'upload' ? '文件已上传' : published ? '已发布' : '草稿已保存');
    } catch (failure) {
      try {
        live(t);
        setUnknown(
          acknowledged ||
            (failure instanceof MemberAssetClientError && failure.outcome === 'unknown'),
        );
        setError(acknowledged ? '已保存，详情读取失败。可重试原请求重新读取。' : message(failure));
      } catch {}
    } finally {
      try {
        live(t);
        setBusy('');
      } catch {}
    }
  }
  function save() {
    if (!detail || !('form' in detail) || detail.kind === 'legacy') return;
    if (!detail.form.definition.name.trim()) {
      setError('请填写资产名称。');
      return;
    }
    const base = {
      spaceId,
      assetId: detail.kind === 'new' ? detail.assetId : detail.value.asset.assetId,
      idempotencyKey: crypto.randomUUID(),
      definition: detail.form.definition,
      dependencies: detail.form.dependencies,
    };
    void perform({
      kind: 'command',
      input:
        detail.kind === 'new'
          ? {
              ...base,
              operation: 'create-draft',
              expectedVersion: 0,
              ...(detail.form.definition.kind === 'file' ? { folderId } : {}),
            }
          : { ...base, operation: 'update-draft', expectedVersion: detail.value.asset.version },
    });
  }
  async function upload(file: File) {
    if (detail?.kind !== 'owned' || detail.value.selection.kind !== 'draft' || dirty) return;
    const t = ticket();
    setBusy('正在校验文件…');
    setError('');
    try {
      const declare = await describeMemberAssetFile(file, t.signal);
      current(t);
      setBusy('');
      void perform({
        kind: 'upload',
        file,
        input: {
          spaceId,
          assetId: detail.value.asset.assetId,
          expectedVersion: detail.value.asset.version,
          idempotencyKey: crypto.randomUUID(),
          declare,
        },
      });
    } catch (failure) {
      try {
        live(t);
        setError(message(failure));
        setBusy('');
      } catch {}
    }
  }
  function publish() {
    if (detail?.kind !== 'owned' || detail.value.selection.kind !== 'draft' || dirty) return;
    void perform({
      kind: 'command',
      input: {
        operation: 'publish',
        spaceId,
        assetId: detail.value.asset.assetId,
        expectedVersion: detail.value.asset.version,
        idempotencyKey: crypto.randomUUID(),
      },
    });
  }
  function copy() {
    if (!detail || detail.kind === 'new' || detail.kind === 'knowledge') return;
    const source =
      detail.kind === 'legacy'
        ? detail.value.source
        : detail.value.selection.kind === 'published'
          ? detail.value.selection.reference
          : undefined;
    if (!source || source.kind === 'unknown') return;
    void perform({
      kind: 'command',
      input: {
        operation: 'copy',
        spaceId,
        assetId: crypto.randomUUID(),
        expectedVersion: 0,
        idempotencyKey: crypto.randomUUID(),
        source,
        name: `${detail.form.definition.name.slice(0, 150)} 副本`,
        dependencies: detail.form.dependencies,
      },
    });
  }
  async function beginEdit() {
    if (detail?.kind !== 'owned') return;
    const asset = detail.value.asset;
    if (asset.hasDraft) return readAsset(asset, 'draft');
    const latest = asset.versions.at(-1)?.reference.versionId;
    if (!latest) return;
    const t = ticket(),
      attempt = ++readAttempt.current;
    rowRead.current?.abort();
    const stop = new AbortController();
    rowRead.current = stop;
    const signal = AbortSignal.any([t.signal, stop.signal]);
    setDetailLoading(true);
    try {
      const value = await api.read({ spaceId, assetId: asset.assetId, versionId: latest }, signal);
      current(t);
      signal.throwIfAborted();
      if (attempt !== readAttempt.current) return;
      accept({ kind: 'owned', value, editing: true, form: formOf(value) });
      setBaseline('');
    } catch (failure) {
      try {
        current(t);
        signal.throwIfAborted();
        if (attempt !== readAttempt.current) return;
        setError(message(failure));
      } catch {}
    } finally {
      try {
        current(t);
        signal.throwIfAborted();
        if (attempt !== readAttempt.current) return;
        setDetailLoading(false);
      } catch {}
    }
  }
  async function readFile(mode: 'preview' | 'download') {
    if (
      detail?.kind !== 'owned' ||
      detail.value.selection.kind !== 'published' ||
      !detail.value.file
    )
      return;
    const t = ticket(),
      value = detail.value,
      file = value.file!;
    setBusy(mode === 'preview' ? '正在读取预览…' : '正在下载…');
    setError('');
    try {
      const content = await api.file(
        {
          spaceId,
          assetId: value.asset.assetId,
          versionId: (value.selection as Extract<typeof value.selection, { kind: 'published' }>)
            .reference.versionId,
          mode,
        },
        file,
        t.signal,
      );
      current(t);
      if (mode === 'preview') setPreview({ file, content });
      else {
        const href = URL.createObjectURL(content.blob),
          link = document.createElement('a');
        link.href = href;
        link.download = file.name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(href), 1000);
      }
    } catch (failure) {
      try {
        live(t);
        setError(message(failure));
      } catch {}
    } finally {
      try {
        live(t);
        setBusy('');
      } catch {}
    }
  }
  function changeCategory(next: Category) {
    if (next === category) return;
    leave.request(() => {
      // A delayed read from the previous category must never reopen its detail.
      ++readAttempt.current;
      rowRead.current?.abort();
      setDetailLoading(false);
      const detailKind = detail
        ? detail.kind === 'knowledge'
          ? 'file'
          : detail.form.definition.kind
        : undefined;
      if (next !== 'all' && next !== (detailKind === 'file' ? 'material' : detailKind)) {
        setDetail(null);
        setPreview(null);
        setBaseline('');
        setIntent(null);
        setUnknown(false);
        setError('');
        setNotice('');
      }
      setCategory(next);
      setOffset(0);
    }, dirty);
  }
  const owned = detail?.kind === 'owned' ? detail : undefined;
  const requirements =
    owned?.value.requirements ?? (detail?.kind === 'legacy' ? detail.value.requirements : []);
  const missingRequirements =
    !!detail &&
    'form' in detail &&
    requirements.some(
      (slot) =>
        !detail.form.dependencies.some(
          (dependency) =>
            dependency.slotId === slot.slotId && dependency.reference.kind === slot.kind,
        ),
    );
  const editing = detail?.kind === 'new' || (owned?.editing && owned.value.asset.canMaintain);
  const canCopy =
    detail?.kind === 'legacy'
      ? detail.value.source.kind !== 'unknown'
      : owned?.value.selection.kind === 'published';
  const selectedKey = owned
    ? JSON.stringify(['asset', spaceId, owned.value.asset.assetId])
    : detail?.kind === 'legacy'
      ? JSON.stringify(['legacy', spaceId, detail.value.source.assetId])
      : detail?.kind === 'knowledge'
        ? JSON.stringify([
            'knowledge',
            spaceId,
            detail.value.reference.libraryId,
            detail.value.reference.pageId,
          ])
        : '';
  const detailView = (
    <div className="zm-member-asset-detail" aria-busy={detailLoading || !!busy}>
      {error && (
        <div className="zm-error" role="alert">
          {error}
          {unknown && intent && (
            <>
              <p>结果尚未确认。请使用原请求重试。</p>
              <Button disabled={!!busy} onClick={() => void perform(intent)}>
                重试原请求
              </Button>
            </>
          )}
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {detailLoading ? (
        <p role="status">正在读取详情…</p>
      ) : !detail ? (
        <div className="zm-empty">
          <h3>选择一项资产</h3>
          <p>查看内容、版本和可用操作。</p>
        </div>
      ) : detail.kind === 'knowledge' ? (
        <article>
          <header>
            <h2>{detail.value.title}</h2>
            <span>v{detail.value.reference.version}</span>
          </header>
          <pre className="zm-member-asset-text">{detail.value.text}</pre>
          {detail.value.nextOffset < detail.value.totalBytes && (
            <p>已显示首段，前往在线文档继续查看。</p>
          )}
          {onOpenKnowledge && <Button onClick={onOpenKnowledge}>打开在线文档</Button>}
        </article>
      ) : (
        <>
          <header className="zm-member-asset-detail-heading">
            <h2>
              {detail.kind === 'new'
                ? `新建${labels[detail.form.definition.kind]}`
                : detail.form.definition.name}
            </h2>
            {owned && (
              <SingleSelect
                label="资产版本"
                value={
                  owned.value.selection.kind === 'draft'
                    ? 'draft'
                    : owned.value.selection.reference.versionId
                }
                disabled={!!busy || unknown}
                options={[
                  ...(owned.value.asset.hasDraft && owned.value.asset.canMaintain
                    ? [{ value: 'draft', label: '草稿' }]
                    : []),
                  ...owned.value.asset.versions
                    .slice()
                    .reverse()
                    .map((version) => ({
                      value: version.reference.versionId,
                      label: `v${version.number} · ${version.publishedBy}`,
                    })),
                ]}
                onValueChange={(value) =>
                  leave.request(() => void readAsset(owned.value.asset, value), dirty)
                }
              />
            )}
          </header>
          {detail.kind !== 'new' && (
            <AssetProvenance detail={detail} members={authoringState?.participants ?? []} />
          )}
          <MemberAssetDefinitionFields
            value={detail.form.definition}
            dependencies={detail.form.dependencies}
            choices={choices}
            {...(authoringState ? { authoringState } : {})}
            requirements={requirements}
            {...(detail.kind === 'legacy' ? { readOnlyDefinition: true } : {})}
            disabled={!!busy || unknown || (!editing && detail.kind !== 'legacy')}
            onChange={(definition, dependencies) =>
              setDetail({ ...detail, form: { definition, dependencies } })
            }
          />
          {!!owned?.value.requirements?.length && (
            <div className="zm-member-asset-requirements">
              {owned.value.requirements.map((requirement) => {
                const draft = skillAssets.find(
                  (asset) =>
                    asset.assetId === requirement.suggestedAssetId &&
                    asset.hasDraft &&
                    asset.canMaintain,
                );
                return (
                  <div key={requirement.slotId}>
                    <span>所需 Skill · {requirement.name}</span>
                    {draft && (
                      <Button
                        disabled={!!busy || unknown}
                        onClick={() => leave.request(() => void readAsset(draft, 'draft'), dirty)}
                      >
                        编辑 Skill 草稿
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {owned?.value.file && (
            <section className="zm-member-asset-file">
              <strong>{owned.value.file.name}</strong>
              <span>{Math.ceil(owned.value.file.byteSize / 1024)} KB</span>
              {owned.value.selection.kind === 'published' && (
                <div className="zm-actions">
                  <Button disabled={!!busy} onClick={() => void readFile('preview')}>
                    预览
                  </Button>
                  <Button disabled={!!busy} onClick={() => void readFile('download')}>
                    下载
                  </Button>
                </div>
              )}
            </section>
          )}
          {editing && detail.form.definition.kind === 'file' && (
            <label className="zm-member-asset-upload">
              {owned?.value.file ? '替换文件' : '上传文件'}
              <input
                type="file"
                aria-label="上传团队文件"
                disabled={
                  !!busy || unknown || dirty || !owned || owned.value.selection.kind !== 'draft'
                }
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file) void upload(file);
                }}
              />
              {(!owned || dirty) && <small>先保存草稿，再选择文件。</small>}
            </label>
          )}
          <footer className="zm-member-asset-actions">
            {editing && (
              <Button
                variant="primary"
                disabled={!!busy || unknown || (!dirty && detail.kind !== 'new')}
                onClick={save}
              >
                保存草稿
              </Button>
            )}
            {owned?.value.selection.kind === 'draft' && owned.value.asset.canPublish && (
              <Button
                disabled={
                  !!busy ||
                  unknown ||
                  dirty ||
                  missingRequirements ||
                  (owned.form.definition.kind === 'file' && !owned.value.file)
                }
                onClick={publish}
              >
                发布
              </Button>
            )}
            {owned && !owned.editing && owned.value.asset.canMaintain && (
              <Button disabled={!!busy || unknown} onClick={() => void beginEdit()}>
                {owned.value.asset.hasDraft ? '编辑草稿' : '编辑最新版本'}
              </Button>
            )}
            {canCopy && (
              <Button disabled={!!busy || unknown} onClick={copy}>
                复制为新资产
              </Button>
            )}
            {busy && <span role="status">{busy}</span>}
          </footer>
        </>
      )}
    </div>
  );
  return (
    <section className="zm-member-assets" aria-label="团队资产">
      {leave.dialog}
      {category !== 'material' && (
        <header className="zm-member-assets-toolbar">
          <input
            type="search"
            aria-label="搜索团队资产"
            placeholder="搜索名称或说明…"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setOffset(0);
            }}
          />
          <div className="zm-actions">
            <Button
              variant="quiet"
              disabled={!!busy || unknown}
              onClick={() =>
                leave.request(() => {
                  setOffset(0);
                  setRefresh((value) => value + 1);
                  if (owned)
                    void readAsset(
                      owned.value.asset,
                      owned.value.selection.kind === 'draft'
                        ? 'draft'
                        : owned.value.selection.reference.versionId,
                    );
                }, dirty)
              }
            >
              刷新
            </Button>
            {onOpenKnowledge && (
              <Button onClick={() => leave.request(onOpenKnowledge, dirty)}>在线文档</Button>
            )}
            <SingleSelect
              label="新建资产"
              popupMinWidth={180}
              value="new"
              disabled={!!busy || unknown}
              options={[
                { value: 'new', label: '＋ 新建' },
                { value: 'file', label: '文件资料' },
                { value: 'expert', label: 'Agent 专家' },
                { value: 'skill', label: 'Skill' },
                { value: 'template', label: '工作流' },
              ]}
              onValueChange={(value) => {
                if (value !== 'new') create(value as MemberAssetDefinition['kind']);
              }}
            />
            <Button
              disabled={!!busy || unknown}
              onClick={() => leave.request(() => setImportOpen(true), dirty)}
            >
              导入
            </Button>
          </div>
        </header>
      )}
      <nav className="zm-asset-categories" aria-label="团队资产分类">
        {categories.map(([kind, label]) => (
          <Button
            key={kind}
            variant="quiet"
            aria-pressed={category === kind}
            disabled={!!busy}
            onClick={() => changeCategory(kind)}
          >
            {label}
            {browse.phase === 'ready' && <span>{browse.value!.counts[kind]}</span>}
          </Button>
        ))}
      </nav>
      {category === 'material' ? (
        <>
          <MemberAssetFilesBrowser
            api={api}
            spaceId={spaceId}
            lifetime={lifetime}
            folderId={folderId}
            onFolderChange={(next) => leave.request(() => setFolderId(next), dirty)}
            refresh={refresh}
            onUpload={() => setUploadTarget({ folderId })}
            onDetails={(asset) => leave.request(() => void readAsset(asset), dirty)}
            {...(onOpenKnowledge
              ? { onOpenKnowledge: () => leave.request(onOpenKnowledge, dirty) }
              : {})}
          />
          {(detail || detailLoading || error) && (
            <Modal
              title="文件信息"
              close={() =>
                leave.request(() => {
                  ++readAttempt.current;
                  rowRead.current?.abort();
                  setDetailLoading(false);
                  setDetail(null);
                  setPreview(null);
                  setBaseline('');
                  setIntent(null);
                  setUnknown(false);
                  setError('');
                  setNotice('');
                }, dirty)
              }
            >
              {detailView}
            </Modal>
          )}
        </>
      ) : (
        <div className="zm-member-assets-layout">
          <div className="zm-member-assets-list" aria-busy={browse.phase === 'loading'}>
            {browse.phase === 'loading' ? (
              <p role="status">正在读取资产…</p>
            ) : browse.phase === 'error' ? (
              <div role="alert">
                {browse.error}
                <Button onClick={() => setRefresh((value) => value + 1)}>重试</Button>
              </div>
            ) : (
              <>
                {!browse.value!.items.length && (
                  <div className="zm-empty">
                    <h3>{search ? '没有匹配的资产' : '还没有资产'}</h3>
                    <Button
                      onClick={() =>
                        create(
                          category === 'expert'
                            ? 'expert'
                            : category === 'skill'
                              ? 'skill'
                              : category === 'template'
                                ? 'template'
                                : 'file',
                        )
                      }
                    >
                      新建
                      {category === 'expert'
                        ? '专家'
                        : category === 'skill'
                          ? 'Skill'
                          : category === 'template'
                            ? '工作流'
                            : '资料'}
                    </Button>
                  </div>
                )}
                {browse.value!.items.map((row) => {
                  const title =
                    row.source === 'asset'
                      ? row.asset.name
                      : row.source === 'knowledge'
                        ? row.page.title
                        : row.legacy.name;
                  const description =
                    row.source === 'asset'
                      ? row.asset.description
                      : row.source === 'knowledge'
                        ? '在线文档'
                        : row.legacy.description;
                  return (
                    <button
                      className={`zm-member-asset-row${category === 'all' ? ' has-kind' : ''}`}
                      key={teamAssetCatalogRowKey(row)}
                      aria-pressed={selectedKey === teamAssetCatalogRowKey(row)}
                      disabled={!!busy || (row.source === 'knowledge' && !knowledge)}
                      onClick={() => leave.request(() => void open(row), dirty)}
                    >
                      {category === 'all' && (
                        <span className="zm-member-asset-kind">
                          {row.source === 'knowledge'
                            ? '文档'
                            : row.source === 'asset'
                              ? labels[row.asset.kind]
                              : labels[row.legacy.kind]}
                        </span>
                      )}
                      <span className="zm-member-asset-caption">
                        <strong>{title}</strong>
                        {description && <small>{description}</small>}
                      </span>
                      <span className="zm-member-asset-state">
                        {row.source === 'asset'
                          ? row.asset.hasDraft
                            ? '草稿'
                            : `v${row.asset.versions.at(-1)?.number ?? ''}`
                          : row.source === 'knowledge'
                            ? `v${row.page.reference.version}`
                            : '只读'}
                      </span>
                    </button>
                  );
                })}
                <div className="zm-member-assets-pagination">
                  <Button
                    disabled={offset === 0}
                    onClick={() => setOffset(Math.max(0, offset - 30))}
                  >
                    上一页
                  </Button>
                  <span>
                    {browse.value!.total
                      ? `${offset + 1}–${offset + browse.value!.items.length} / ${browse.value!.total}`
                      : '0 项'}
                  </span>
                  <Button
                    disabled={browse.value!.nextOffset === null}
                    onClick={() => setOffset(browse.value!.nextOffset!)}
                  >
                    下一页
                  </Button>
                </div>
              </>
            )}
          </div>
          {detailView}
        </div>
      )}
      {uploadTarget && (
        <MemberAssetFilesUploadDialog
          api={uploadApi}
          spaceId={spaceId}
          lifetime={lifetime}
          close={() => setUploadTarget(undefined)}
          onChanged={() => {
            setRefresh((value) => value + 1);
            onChanged?.();
          }}
        />
      )}
      {preview && <MemberAssetFilePreview value={preview} close={() => setPreview(null)} />}
      {importOpen && (
        <MemberAssetImportDialog
          api={api}
          spaceId={spaceId}
          lifetime={lifetime}
          close={() => setImportOpen(false)}
          imported={(value) => {
            setImportOpen(false);
            setRefresh((current) => current + 1);
            const first = value.assets.find((asset) => asset.kind === 'expert') ?? value.assets[0];
            if (first) void readAsset(first, 'draft');
          }}
        />
      )}
    </section>
  );
}

function AssetProvenance({
  detail,
  members,
}: {
  detail: Extract<Detail, { kind: 'owned' | 'legacy' }>;
  members: Workbench['participants'];
}) {
  const source = detail.value.source;
  const person = (id: string) => members.find((member) => member.id === id)?.name ?? id;
  const owner =
    detail.kind === 'owned'
      ? detail.value.asset.ownerId
      : source?.kind === 'member-template'
        ? source.ownerId
        : undefined;
  const kinds = {
    asset: '复制自团队资产',
    builtin: '内置资源',
    package: '导入资源包',
    import: '导入资源包',
    'member-template': '已保存的工作流',
    unknown: '来源未确认',
  };
  const digest =
    source?.kind === 'asset'
      ? source.reference.sha256
      : source && 'sha256' in source
        ? source.sha256
        : undefined;
  const version =
    source?.kind === 'asset'
      ? source.reference.versionId
      : source && 'versionId' in source
        ? source.versionId
        : source?.kind === 'builtin'
          ? source.sourceCommit
          : undefined;
  return (
    <details className="zm-asset-provenance">
      <summary>来源与维护</summary>
      <dl>
        <dt>来源</dt>
        <dd>{source ? kinds[source.kind] : '团队资产'}</dd>
        {owner && (
          <>
            <dt>创建者</dt>
            <dd>{person(owner)}</dd>
          </>
        )}
        {detail.kind === 'owned' && (
          <>
            <dt>维护者</dt>
            <dd>{detail.value.asset.maintainerIds.map(person).join('、')}</dd>
          </>
        )}
        {source?.kind === 'import' && source.entryPath && (
          <>
            <dt>来源文件</dt>
            <dd>{source.entryPath}</dd>
          </>
        )}
        {source?.kind === 'import' && source.sourceVersion && (
          <>
            <dt>来源声明版本</dt>
            <dd>{source.sourceVersion}</dd>
          </>
        )}
        {version && (
          <>
            <dt>固定来源版本</dt>
            <dd>
              <code>{version}</code>
            </dd>
          </>
        )}
        {digest && (
          <>
            <dt>来源摘要</dt>
            <dd>
              <code>{digest}</code>
            </dd>
          </>
        )}
      </dl>
    </details>
  );
}
