import { useEffect, useRef, useState } from 'react';
import {
  MemberAssetFileReferencesSchema,
  type Project,
  type MemberAssetReadValue,
  type MemberAssetReference,
} from '@zhuma/agent-core';
import { Button } from '../workbench/Button.js';
import { Modal } from '../workbench/controls.js';
import { SingleSelect } from '../workbench/SingleSelect.js';
import { useUnsavedChanges } from '../workbench/UnsavedChanges.js';
import { MemberAssetClientError, type MemberAssetApi, type MemberAssetFileContent } from './api.js';
import { MemberAssetFilePreview } from './MemberAssetFilePreview.js';

type References = NonNullable<Project['fileRefs']>;
type Summary = MemberAssetReadValue['asset'];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const message = (error: unknown) =>
  error instanceof MemberAssetClientError ? error.message : '资料暂不可用，请重试。';

/** One fixed-version picker shared by project defaults and task drafts.
 * Opening it reads metadata only. Neither defaults nor a newer version are
 * written without the person's explicit selection and parent form save. */
export function MemberAssetFilePicker({
  api,
  spaceId,
  value,
  change,
  disabled = false,
  label = '任务资料',
  hint,
}: {
  api: MemberAssetApi;
  spaceId: string;
  value: References | undefined;
  change(value: References): void;
  disabled?: boolean;
  label?: string;
  hint?: string;
}) {
  const [open, setOpen] = useState(false),
    [draft, setDraft] = useState<References>([]),
    [assets, setAssets] = useState<Summary[]>([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [listFailed, setListFailed] = useState(false),
    [search, setSearch] = useState(''),
    [limit, setLimit] = useState(30),
    [refresh, setRefresh] = useState(0);
  const [versions, setVersions] = useState<Record<string, string>>({}),
    [expanded, setExpanded] = useState(false),
    [preview, setPreview] = useState<{
      file: NonNullable<MemberAssetReadValue['file']>;
      content: MemberAssetFileContent;
      title: string;
    }>(),
    [reading, setReading] = useState(false);
  const epoch = useRef({ api, spaceId, controller: new AbortController() }),
    mounted = useRef(false);
  if (epoch.current.api !== api || epoch.current.spaceId !== spaceId) {
    epoch.current.controller.abort();
    epoch.current = { api, spaceId, controller: new AbortController() };
  }
  const baseline = useRef('[]'),
    previewOperation = useRef<AbortController>();
  useUnsavedChanges(open && JSON.stringify(draft) !== baseline.current);
  useEffect(() => {
    mounted.current = true;
    const owner = epoch.current;
    if (owner.controller.signal.aborted) owner.controller = new AbortController();
    setOpen(false);
    setPreview(undefined);
    setReading(false);
    setAssets([]);
    return () => {
      mounted.current = false;
      owner.controller.abort();
      previewOperation.current?.abort();
    };
  }, [api, spaceId]);
  useEffect(() => {
    if (disabled) {
      previewOperation.current?.abort();
      previewOperation.current = undefined;
      setReading(false);
      setOpen(false);
      setPreview(undefined);
    }
  }, [disabled]);
  useEffect(() => {
    const owner = epoch.current,
      controller = new AbortController(),
      signal = AbortSignal.any([controller.signal, owner.controller.signal]);
    setLoading(true);
    setListFailed(false);
    setError('');
    void api
      .list({ spaceId, kind: 'file', includeDrafts: false }, signal)
      .then((result) => {
        if (mounted.current && epoch.current === owner && !signal.aborted) setAssets(result.items);
      })
      .catch((failure) => {
        if (mounted.current && epoch.current === owner && !signal.aborted) {
          setError(message(failure));
          setListFailed(true);
        }
      })
      .finally(() => {
        if (mounted.current && epoch.current === owner && !signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, spaceId, refresh]);
  const fixed = value ?? [];
  function begin() {
    setDraft(structuredClone(fixed));
    baseline.current = JSON.stringify(fixed);
    setVersions({});
    setSearch('');
    setLimit(30);
    setOpen(true);
  }
  function selectedVersion(asset: Summary) {
    const chosen = versions[asset.assetId],
      selected = draft.find((item) => item.assetId === asset.assetId);
    if (chosen) return asset.versions.find((item) => item.reference.versionId === chosen);
    return selected
      ? asset.versions.find((item) => same(item.reference, selected))
      : asset.versions.at(-1);
  }
  function choose(reference: MemberAssetReference, assetId: string, replaceOnly = false) {
    const parsed = MemberAssetFileReferencesSchema.safeParse([reference]);
    if (!parsed.success || reference.spaceId !== spaceId) {
      setError('资料版本无效，请刷新后重新选择。');
      return;
    }
    const fixed = parsed.data[0]!;
    setDraft((current) =>
      replaceOnly
        ? current.map((item) => (item.assetId === assetId ? fixed : item))
        : [...current.filter((item) => item.assetId !== assetId), fixed],
    );
  }
  function describe(reference: MemberAssetReference) {
    const asset = assets.find((item) => item.assetId === reference.assetId),
      version = asset?.versions.find((item) => same(item.reference, reference));
    return {
      asset,
      version,
      title: version ? `${asset!.name} · v${version.number}` : '固定资料暂不可用',
    };
  }
  async function read(reference: MemberAssetReference) {
    const owner = epoch.current,
      operation = new AbortController();
    previewOperation.current?.abort();
    previewOperation.current = operation;
    const signal = AbortSignal.any([
      operation.signal,
      owner.controller.signal,
      AbortSignal.timeout(125000),
    ]);
    const current = () => {
      if (!mounted.current || epoch.current !== owner || previewOperation.current !== operation)
        throw new DOMException('File picker changed', 'AbortError');
    };
    setReading(true);
    setError('');
    try {
      const detail = await api.read(
        { spaceId, assetId: reference.assetId, versionId: reference.versionId },
        signal,
      );
      current();
      signal.throwIfAborted();
      if (
        !detail.file ||
        detail.selection.kind !== 'published' ||
        !same(detail.selection.reference, reference)
      )
        throw new Error('wrong fixed version');
      const content = await api.file(
        { spaceId, assetId: reference.assetId, versionId: reference.versionId, mode: 'preview' },
        detail.file,
        signal,
      );
      current();
      signal.throwIfAborted();
      setPreview({ file: detail.file, content, title: describe(reference).title });
    } catch (failure) {
      try {
        current();
        setError(message(failure));
      } catch {}
    } finally {
      try {
        current();
        setReading(false);
      } catch {}
    }
  }
  function close() {
    previewOperation.current?.abort();
    previewOperation.current = undefined;
    setReading(false);
    setOpen(false);
    setPreview(undefined);
  }
  const matches = assets.filter(
    (asset) =>
      asset.versions.length &&
      `${asset.name} ${asset.description}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  return (
    <section className="zm-fixed-file-picker" aria-label={label}>
      <div className="zm-fixed-file-heading">
        <strong>
          {label}
          {fixed.length ? ` · ${fixed.length}` : ''}
        </strong>
        {!disabled && <Button onClick={begin}>选择资料</Button>}
      </div>
      {hint && <small>{hint}</small>}
      {!!fixed.length && (
        <ul className="zm-fixed-files">
          {(expanded ? fixed : fixed.slice(0, 3)).map((reference) => {
            const { version, title } = describe(reference);
            return (
              <li key={reference.assetId}>
                <span>{title}</span>
                <Button
                  variant="quiet"
                  disabled={reading || !version}
                  onClick={() => void read(reference)}
                >
                  预览
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {!fixed.length && <small>未选择资料</small>}
      {fixed.length > 3 && (
        <Button variant="quiet" onClick={() => setExpanded((current) => !current)}>
          {expanded ? '收起资料' : `查看全部 ${fixed.length} 项`}
        </Button>
      )}
      {!open && error && <p role="alert">{error}</p>}
      {open && (
        <Modal title="选择资料" close={close}>
          <div className="zm-fixed-file-dialog">
            <div className="zm-fixed-file-heading">
              <input
                aria-label="搜索资料"
                placeholder="搜索已发布资料"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setLimit(30);
                }}
              />
              <Button variant="quiet" onClick={() => setRefresh((current) => current + 1)}>
                刷新
              </Button>
            </div>
            {error && <p role="alert">{error}</p>}
            {loading ? (
              <p role="status">正在读取资料…</p>
            ) : listFailed ? (
              <Button onClick={() => setRefresh((current) => current + 1)}>重试读取</Button>
            ) : !matches.length ? (
              <p>没有匹配的已发布资料。可先到团队资产上传并发布。</p>
            ) : (
              <div className="zm-fixed-file-choices">
                {matches.slice(0, limit).map((asset) => {
                  const version = selectedVersion(asset),
                    selected = draft.some((item) => item.assetId === asset.assetId);
                  return (
                    <div className="zm-fixed-file-choice" key={asset.assetId}>
                      <label>
                        <input
                          type="checkbox"
                          aria-label={`选择资料 ${asset.name}`}
                          checked={selected}
                          disabled={!selected && (draft.length >= 50 || !version)}
                          onChange={(event) => {
                            if (event.target.checked && version)
                              choose(version.reference, asset.assetId);
                            else
                              setDraft((current) =>
                                current.filter((item) => item.assetId !== asset.assetId),
                              );
                          }}
                        />
                        <span>
                          <strong>{asset.name}</strong>
                          {asset.description && <small>{asset.description}</small>}
                        </span>
                      </label>
                      <SingleSelect
                        label={`资料版本 ${asset.name}`}
                        value={version?.reference.versionId ?? ''}
                        triggerContent={version ? `v${version.number}` : '原版本不可用'}
                        options={asset.versions.map((item) => ({
                          value: item.reference.versionId,
                          label: `v${item.number}`,
                        }))}
                        onValueChange={(versionId) => {
                          const chosen = asset.versions.find(
                            (item) => item.reference.versionId === versionId,
                          );
                          if (!chosen) return;
                          setVersions((current) => ({ ...current, [asset.assetId]: versionId }));
                          choose(chosen.reference, asset.assetId, true);
                        }}
                      />
                      <Button
                        variant="quiet"
                        disabled={reading || !version}
                        onClick={() => {
                          if (version) void read(version.reference);
                        }}
                      >
                        预览
                      </Button>
                    </div>
                  );
                })}
                {matches.length > limit && (
                  <Button onClick={() => setLimit((current) => current + 30)}>显示更多</Button>
                )}
              </div>
            )}
            {!!draft.length && (
              <div className="zm-fixed-file-selected">
                <strong>已选 {draft.length} / 50</strong>
                {draft.map((reference) => (
                  <div key={reference.assetId}>
                    <span>{describe(reference).title}</span>
                    <Button
                      variant="quiet"
                      aria-label={`移除资料 ${reference.assetId}`}
                      onClick={() =>
                        setDraft((current) =>
                          current.filter((item) => item.assetId !== reference.assetId),
                        )
                      }
                    >
                      移除
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <footer>
              <Button onClick={close}>取消</Button>
              <Button
                variant="primary"
                disabled={loading || listFailed}
                onClick={() => {
                  const parsed = MemberAssetFileReferencesSchema.safeParse(draft);
                  if (!parsed.success || parsed.data.some((item) => item.spaceId !== spaceId)) {
                    setError('资料引用不完整，请重新选择。');
                    return;
                  }
                  if (parsed.data.some((reference) => !describe(reference).version)) {
                    setError('有资料版本当前不可用，请移除或重新选择。');
                    return;
                  }
                  change(parsed.data);
                  close();
                }}
              >
                确认选择
              </Button>
            </footer>
          </div>
        </Modal>
      )}
      {preview && (
        <MemberAssetFilePreview
          value={preview}
          title={preview.title}
          close={() => setPreview(undefined)}
        />
      )}
    </section>
  );
}
