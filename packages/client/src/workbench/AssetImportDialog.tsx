import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ASSET_IMPORT_LIMITS,
  privatePackagePath,
  validPackagePath,
  packageFileText,
  type Workbench,
  type ImportPackagePreview,
  type ImportPackageInput,
  type PackageUpload,
} from '@zhuma/agent-core';
import type { WorkbenchApi } from './api.js';
import { Modal, Field } from './controls.js';
import { Button } from './Button.js';
import { SingleSelect } from './SingleSelect.js';
import { SourceFiles } from './SourceFiles.js';

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768)
    binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(binary);
}
async function upload(files: File[], signal: AbortSignal): Promise<PackageUpload> {
  if (!files.length || files.length > ASSET_IMPORT_LIMITS.files)
    throw Error('一次选择 1–100 个文件。');
  if (files.length === 1 && /\.zip$/iu.test(files[0]!.name)) {
    if (files[0]!.size > ASSET_IMPORT_LIMITS.totalBytes) throw Error('ZIP 文件最多 2 MiB。');
    const bytes = await files[0]!.arrayBuffer();
    signal.throwIfAborted();
    return { kind: 'zip', data: base64(new Uint8Array(bytes)) };
  }
  let total = 0;
  const seen = new Set<string>();
  for (const file of files) {
    const path = file.webkitRelativePath || file.name;
    if (!validPackagePath(path)) throw Error('文件路径无效，请选择普通文件或重新打包。');
    const key = path.normalize('NFC').toLowerCase();
    if (seen.has(key)) throw Error(`存在重复路径：${path}`);
    seen.add(key);
    total += file.size;
    if (file.size > ASSET_IMPORT_LIMITS.fileBytes || total > ASSET_IMPORT_LIMITS.totalBytes)
      throw Error('单文件最多 256 KiB，总量最多 2 MiB。');
    if (/\.zip$/iu.test(file.name)) throw Error('ZIP 需单独选择，不能与其他文件混合导入。');
  }
  const source: Extract<PackageUpload, { kind: 'files' }> = { kind: 'files', files: [] };
  for (const file of files) {
    signal.throwIfAborted();
    const path = file.webkitRelativePath || file.name;
    // Inspect names before reading: excluded private files are never read or uploaded.
    source.files.push({
      path,
      data: privatePackagePath(path) ? '' : base64(new Uint8Array(await file.arrayBuffer())),
    });
  }
  signal.throwIfAborted();
  return source;
}

export function AssetImportDialog({
  state,
  api,
  saved,
  close,
  legacy,
}: {
  state: Workbench;
  api: WorkbenchApi;
  saved(state: Workbench): void;
  close(): void;
  legacy(name: string, content: string): void;
}) {
  const fileRef = useRef<HTMLInputElement>(null),
    folderRef = useRef<HTMLInputElement>(null);
  const read = useRef<AbortController | null>(null);
  const saving = useRef(false);
  const retry = useRef<{ payload: string; id: string; revision: number } | null>(null);
  const [reading, setReading] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [preview, setPreview] = useState<ImportPackagePreview | null>(null);
  const [choices, setChoices] = useState<ImportPackageInput['choices']>([]);
  const [selected, setSelected] = useState('');
  const [versionId, setVersionId] = useState('');
  const [tab, setTab] = useState<'definition' | 'files'>('definition');
  useEffect(() => {
    folderRef.current?.setAttribute('webkitdirectory', '');
    return () => read.current?.abort();
  }, []);
  const item = preview?.items.find((i) => i.key === selected) ?? preview?.items[0];
  const choice = choices.find((c) => c.key === item?.key);
  const change = (patch: Partial<ImportPackageInput['choices'][number]>) =>
    setChoices((current) => current.map((c) => (c.key === item?.key ? { ...c, ...patch } : c)));
  const targets =
    item?.kind === 'expert'
      ? state.participants.filter((p) => p.kind === 'expert')
      : state.assets.filter((a) => a.kind === item?.kind);
  const conflict =
    choice &&
    targets?.some(
      (t) =>
        t.id !== choice.id &&
        t.name.normalize('NFC').toLowerCase() === choice.name.trim().normalize('NFC').toLowerCase(),
    );
  const missing = item
    ? [
        ...item.missing,
        ...item.skillKeys.filter(
          (key) =>
            !choices.some((c) => c.key === key && c.available) ||
            !!preview?.items.find((i) => i.key === key)?.missing.length,
        ),
      ]
    : [];
  async function choose(files: File[]) {
    read.current?.abort();
    const controller = new AbortController();
    read.current = controller;
    setReading(true);
    setError('');
    try {
      const source = await upload(files, controller.signal);
      if (
        source.kind === 'files' &&
        source.files.length === 1 &&
        !source.files[0]!.path.includes('/') &&
        !privatePackagePath(source.files[0]!.path) &&
        !['SKILL.md', 'SOUL.md', 'IDENTITY.md', 'AGENTS.md'].includes(source.files[0]!.path)
      ) {
        const text = packageFileText(source.files[0]!);
        let format: unknown;
        try {
          const value = JSON.parse(text);
          format = value && typeof value === 'object' ? value.format : undefined;
        } catch {
          /* Plain text uses the existing editor. */
        }
        if (!format) {
          if (text.length > 8000)
            throw Error('普通文字定义最多 8000 字符；较大的定义请使用 Skill／专家标准格式。');
          legacy(files[0]!.name.replace(/\.[^.]+$/u, '').slice(0, 160), text);
          return;
        }
      }
      const result = await api.previewImport(source, controller.signal);
      if (controller.signal.aborted) return;
      setPreview(result);
      setChoices(
        result.items.map((i) => ({
          key: i.key,
          id: crypto.randomUUID(),
          replace: false,
          name: i.name,
          description: i.description,
          role: i.role,
          capabilities: i.capabilities,
          available: true,
        })),
      );
      setVersionId(crypto.randomUUID());
      setSelected(result.items[0]!.key);
      setTab('definition');
      retry.current = null;
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : '读取失败，请重试。');
    } finally {
      if (!controller.signal.aborted) setReading(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!preview || !choices.length || saving.current) return;
    const command = {
      type: 'import-package' as const,
      input: { versionId, files: preview.files, choices },
    };
    const payload = JSON.stringify(command);
    if (retry.current?.payload !== payload)
      retry.current = { payload, id: crypto.randomUUID(), revision: state.revision };
    saving.current = true;
    setBusy(true);
    setError('');
    try {
      saved(await api.save(retry.current.revision, command, retry.current.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败，请重试。');
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      title="导入资产"
      close={() => {
        if (!saving.current) close();
      }}
    >
      <form className="zm-asset-import-form" onSubmit={(e) => void submit(e)}>
        <div className="zm-import-source">
          <Button disabled={busy || reading} onClick={() => fileRef.current?.click()}>
            选择文件或 ZIP
          </Button>
          <Button disabled={busy || reading} onClick={() => folderRef.current?.click()}>
            选择文件夹
          </Button>
          <span className="zm-muted">Agent Skills · OpenClaw · Zhuma 专家／工作流</span>
          <input
            hidden
            ref={fileRef}
            aria-label="选择资产文件"
            type="file"
            multiple
            accept=".zip,.md,.json,.txt"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = '';
              if (files.length) void choose(files);
            }}
          />
          <input
            hidden
            ref={folderRef}
            aria-label="选择资产文件夹"
            type="file"
            multiple
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = '';
              if (files.length) void choose(files);
            }}
          />
        </div>
        {error && (
          <p role="alert" className="zm-error zm-dialog-error">
            {error}
          </p>
        )}
        {reading && (
          <p role="status" className="zm-import-loading">
            正在识别内容与依赖…
          </p>
        )}
        {!preview && !reading && (
          <div className="zm-import-empty">
            <strong>把已有方法和专家带进来</strong>
            <p>选择 SKILL.md、SOUL.md、定义文件，或包含附件的目录／ZIP。</p>
            <small className="zm-muted">最多 100 个文件 · 单文件 256 KiB · 总量 2 MiB</small>
          </div>
        )}
        {preview && (
          <fieldset disabled={busy || reading} className="zm-import-layout">
            <aside className="zm-import-items" aria-label="识别的定义">
              {preview.items.map((i) => (
                <div key={i.key} className={i.key === item?.key ? 'active' : ''}>
                  <input
                    type="checkbox"
                    aria-label={`导入 ${i.name}`}
                    checked={choices.some((c) => c.key === i.key)}
                    onChange={(e) =>
                      setChoices(
                        e.target.checked
                          ? [
                              ...choices,
                              {
                                key: i.key,
                                id: crypto.randomUUID(),
                                replace: false,
                                name: i.name,
                                description: i.description,
                                role: i.role,
                                capabilities: i.capabilities,
                                available: true,
                              },
                            ]
                          : choices.filter((c) => c.key !== i.key),
                      )
                    }
                  />
                  <Button
                    variant="quiet"
                    onClick={() => {
                      setSelected(i.key);
                      setTab('definition');
                    }}
                  >
                    <strong>{i.name}</strong>
                    <small>
                      {i.kind === 'expert'
                        ? 'Agent 专家'
                        : i.kind === 'template'
                          ? '工作流'
                          : 'Skill'}{' '}
                      · {i.filePaths.length} 个文件
                    </small>
                  </Button>
                </div>
              ))}
              {!!preview.ignored.length && (
                <details>
                  <summary>已忽略 {preview.ignored.length} 项</summary>
                  <ul>
                    {preview.ignored.map((f) => (
                      <li key={f.path}>
                        <span>{f.path}</span>
                        <small>{f.reason}</small>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </aside>
            <div className="zm-import-detail">
              {item && (
                <>
                  <div className="zm-import-detail-heading">
                    <strong>{item.name}</strong>
                    <span className="zm-muted">{item.format}</span>
                    {!!missing.length && (
                      <small className="zm-warning">需补齐 {missing.length} 项</small>
                    )}
                  </div>
                  <div className="zm-view-switch">
                    <Button
                      aria-pressed={tab === 'definition'}
                      onClick={() => setTab('definition')}
                    >
                      定义
                    </Button>
                    <Button aria-pressed={tab === 'files'} onClick={() => setTab('files')}>
                      文件 {item.filePaths.length}
                    </Button>
                  </div>
                  {tab === 'files' ? (
                    <SourceFiles
                      key={item.key}
                      files={preview.files.filter((f) => item.filePaths.includes(f.path))}
                    />
                  ) : (
                    <>
                      {choice ? (
                        <>
                          <Field label="名称">
                            <input
                              required
                              maxLength={160}
                              value={choice.name}
                              onChange={(e) => change({ name: e.target.value })}
                            />
                          </Field>
                          <Field label="保存方式">
                            <SingleSelect
                              label="导入保存方式"
                              value={choice.replace ? choice.id : 'new'}
                              options={[
                                { value: 'new', label: '新建定义' },
                                ...(targets ?? []).map((t) => ({
                                  value: t.id,
                                  label: `更新：${t.name}`,
                                })),
                              ]}
                              onValueChange={(value) =>
                                change({
                                  replace: value !== 'new',
                                  id: value === 'new' ? crypto.randomUUID() : value,
                                })
                              }
                            />
                          </Field>
                          {conflict && (
                            <p className="zm-warning">名称已存在，请改名或选择更新已有定义。</p>
                          )}
                          {item.kind === 'expert' ? (
                            <>
                              <Field label="职责">
                                <input
                                  maxLength={300}
                                  value={choice.role}
                                  onChange={(e) => change({ role: e.target.value })}
                                />
                              </Field>
                              <Field label="能力关键词">
                                <input
                                  value={choice.capabilities.join('，')}
                                  onChange={(e) =>
                                    change({
                                      capabilities: [
                                        ...new Set(
                                          e.target.value
                                            .split(/[,，]/u)
                                            .map((s) => s.trim())
                                            .filter(Boolean),
                                        ),
                                      ],
                                    })
                                  }
                                />
                              </Field>
                            </>
                          ) : (
                            <Field label="用途与适用场景">
                              <textarea
                                rows={2}
                                maxLength={8000}
                                value={choice.description}
                                onChange={(e) => change({ description: e.target.value })}
                              />
                            </Field>
                          )}
                          <label className="zm-check-row">
                            <input
                              type="checkbox"
                              checked={choice.available && !missing.length}
                              disabled={!!missing.length}
                              onChange={(e) => change({ available: e.target.checked })}
                            />
                            导入后可选用
                          </label>
                        </>
                      ) : (
                        <p className="zm-muted">此定义未勾选，不会保存。</p>
                      )}
                      {!!missing.length && (
                        <div className="zm-import-missing">
                          <strong>需补齐 {missing.length} 项，将保存为停用</strong>
                          <ul>
                            {missing.map((p, index) => (
                              <li key={index}>{p}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {!!item.skillKeys.length && (
                        <p className="zm-muted">
                          默认 Skills：
                          {item.skillKeys
                            .map((k) => preview.items.find((i) => i.key === k)?.name ?? k)
                            .join('、')}
                        </p>
                      )}
                      {!!item.requirements.length && (
                        <details>
                          <summary>来源声明 {item.requirements.length}</summary>
                          <ul>
                            {item.requirements.map((r, index) => (
                              <li key={index}>{r}</li>
                            ))}
                          </ul>
                        </details>
                      )}
                      <details>
                        <summary>{item.kind === 'expert' ? '人格与工作方法' : '定义正文'}</summary>
                        <pre tabIndex={0}>{item.content}</pre>
                      </details>
                      {item.sourceVersion && (
                        <small className="zm-muted">来源版本：{item.sourceVersion}</small>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          </fieldset>
        )}
        <footer>
          <span className="zm-muted">保存到当前工作台</span>
          <Button disabled={busy} onClick={close}>
            取消
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!choices.length || reading}
            busy={busy}
            busyLabel="正在导入…"
          >
            导入 {choices.length} 项
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
