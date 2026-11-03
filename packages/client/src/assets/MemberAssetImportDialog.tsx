import { useEffect, useRef, useState } from 'react';
import {
  type MemberAssetPreviewImportValue,
  type MemberAssetImportDraftsQuery,
  type MemberAssetImportDraftsValue,
  type PackageUpload,
} from '@zhuma/agent-core';
import type { MemberSpaceLifetime } from '../identity/MemberSpaceBoundary.js';
import { Modal, Field } from '../workbench/controls.js';
import { Button } from '../workbench/Button.js';
import { useLeaveConfirmation } from '../workbench/useLeaveConfirmation.js';
import { useUnsavedChanges } from '../workbench/UnsavedChanges.js';
import { readAssetPackageUpload } from './package-upload.js';
import { MemberAssetClientError, type MemberAssetApi } from './api.js';
type Choice = MemberAssetImportDraftsQuery['choices'][number];
const label = { skill: 'Skill', expert: 'Agent 专家', template: '工作流' };

/** Static package preview/import only. Source bytes and stable retry intent
 * stay in this view; the original service owns drafts, source and receipts. */
export function MemberAssetImportDialog({
  api,
  spaceId,
  lifetime,
  close,
  imported,
}: {
  api: MemberAssetApi;
  spaceId: string;
  lifetime: MemberSpaceLifetime;
  close(): void;
  imported(value: MemberAssetImportDraftsValue): void;
}) {
  const [preview, setPreview] = useState<MemberAssetPreviewImportValue | null>(null),
    [source, setSource] = useState<PackageUpload | null>(null);
  const [choices, setChoices] = useState<Choice[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [active, setActive] = useState('');
  const [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [unknown, setUnknown] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null),
    folderInput = useRef<HTMLInputElement>(null),
    operation = useRef<AbortController>();
  const activeSignal = useRef<AbortSignal>();
  const mounted = useRef(false),
    currentLifetime = useRef(lifetime),
    intent = useRef<MemberAssetImportDraftsQuery | null>(null);
  currentLifetime.current = lifetime;
  const leave = useLeaveConfirmation(() => mounted.current && currentLifetime.current.isCurrent());
  useUnsavedChanges(!!preview || !!busy || unknown);
  useEffect(() => {
    mounted.current = true;
    folderInput.current?.setAttribute('webkitdirectory', '');
    return () => {
      mounted.current = false;
      operation.current?.abort();
    };
  }, []);
  function live(signal: AbortSignal) {
    if (!mounted.current || activeSignal.current !== signal || !currentLifetime.current.isCurrent())
      throw new DOMException('Import view changed', 'AbortError');
  }
  function current(signal: AbortSignal) {
    live(signal);
    signal.throwIfAborted();
  }
  function begin() {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(125_000)]);
    activeSignal.current = signal;
    return signal;
  }
  async function read(files: File[]) {
    const signal = begin();
    setBusy('正在预览…');
    setError('');
    setPreview(null);
    setSource(null);
    setUnknown(false);
    intent.current = null;
    try {
      const upload = await readAssetPackageUpload(files, signal);
      current(signal);
      const value = await api.previewImport({ spaceId, upload }, signal);
      current(signal);
      const all = value.items.map((item) => ({
        key: item.key,
        id: crypto.randomUUID(),
        name: item.name,
        description: item.description,
        role: item.role,
        capabilities: item.capabilities,
        dependencies: [],
      }));
      setSource(upload);
      setPreview(value);
      setChoices(all);
      setSelected(all.map((choice) => choice.key));
      setActive(all[0]!.key);
    } catch (failure) {
      try {
        live(signal);
        setError(
          failure instanceof MemberAssetClientError
            ? failure.message
            : '文件读取或预检失败，请核对格式和大小后重试。',
        );
      } catch {}
    } finally {
      try {
        live(signal);
        setBusy('');
      } catch {}
    }
  }
  async function save() {
    if (busy || !source || !preview) return;
    const signal = begin(),
      input = intent.current ?? {
        spaceId,
        upload: source,
        packageChecksum: preview.packageChecksum,
        idempotencyKey: crypto.randomUUID(),
        choices: choices.filter((choice) => selected.includes(choice.key)),
      };
    intent.current = input;
    setBusy('正在导入…');
    setError('');
    setUnknown(false);
    try {
      const value = await api.importDrafts(input, signal);
      current(signal);
      intent.current = null;
      imported(value);
    } catch (failure) {
      try {
        live(signal);
        setUnknown(failure instanceof MemberAssetClientError && failure.outcome === 'unknown');
        setError(
          failure instanceof MemberAssetClientError
            ? failure.message
            : '导入尚未完成，请核对原结果。',
        );
      } catch {}
    } finally {
      try {
        live(signal);
        setBusy('');
      } catch {}
    }
  }
  const item = preview?.items.find((value) => value.key === active),
    choice = choices.find((value) => value.key === active),
    locked = !!busy || unknown;
  const change = (patch: Partial<Choice>) => {
    intent.current = null;
    setChoices((values) =>
      values.map((value) => (value.key === active ? { ...value, ...patch } : value)),
    );
  };
  return (
    <>
      <Modal title="导入资产" close={() => leave.request(close, !!preview || !!busy || unknown)}>
        <div className="zm-form zm-member-asset-import">
          <div className="zm-actions">
            <Button disabled={locked} onClick={() => fileInput.current?.click()}>
              选择文件或 ZIP
            </Button>
            <Button disabled={locked} onClick={() => folderInput.current?.click()}>
              选择目录
            </Button>
          </div>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            aria-label="导入资产文件"
            disabled={locked}
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = '';
              if (files.length) void read(files);
            }}
          />
          <input
            ref={folderInput}
            type="file"
            multiple
            hidden
            aria-label="导入资产目录"
            disabled={locked}
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = '';
              if (files.length) void read(files);
            }}
          />
          {!preview && !busy && <p>支持 Skill、专家定义和工作流；最多 100 个文件、合计 2 MiB。</p>}
          {error && (
            <div className="zm-error" role="alert">
              {error}
              {unknown && <p>结果尚未确认，请重试原请求。</p>}
            </div>
          )}
          {busy && <p role="status">{busy}</p>}
          {preview && (
            <>
              <div className="zm-member-import-layout">
                <div className="zm-member-import-items">
                  {preview.items.map((value) => (
                    <div key={value.key}>
                      <label>
                        <input
                          type="checkbox"
                          checked={selected.includes(value.key)}
                          disabled={locked}
                          onChange={(event) => {
                            intent.current = null;
                            setSelected((values) =>
                              event.target.checked
                                ? [...values, value.key]
                                : values.filter((key) => key !== value.key),
                            );
                          }}
                        />
                        <span>{label[value.kind]}</span>
                      </label>
                      <Button
                        variant="quiet"
                        disabled={!!busy}
                        aria-pressed={active === value.key}
                        onClick={() => setActive(value.key)}
                      >
                        {choices.find((choice) => choice.key === value.key)?.name || value.name}
                      </Button>
                    </div>
                  ))}
                </div>
                {item && choice && (
                  <div className="zm-member-import-definition">
                    <Field label="导入名称">
                      <input
                        value={choice.name}
                        maxLength={160}
                        disabled={locked}
                        onChange={(event) => change({ name: event.target.value })}
                      />
                    </Field>
                    <Field label="导入描述">
                      <textarea
                        value={choice.description}
                        maxLength={8000}
                        rows={3}
                        disabled={locked}
                        onChange={(event) => change({ description: event.target.value })}
                      />
                    </Field>
                    <details>
                      <summary>查看完整内容</summary>
                      <pre className="zm-member-asset-text">{item.content}</pre>
                    </details>
                    {!!item.skillKeys.length && (
                      <p>
                        此专家包含 {item.skillKeys.length} 项 Skill 依赖；导入后先发布所需 Skill。
                      </p>
                    )}
                    {!!item.missing.length && (
                      <ul>
                        {item.missing.map((value, index) => (
                          <li key={index}>{value}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
              {!!preview.ignored.length && (
                <details>
                  <summary>已忽略 {preview.ignored.length} 个文件</summary>
                  <ul>
                    {preview.ignored.map((value, index) => (
                      <li key={index}>
                        {value.path} · {value.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <p>导入只生成草稿，核对后再发布。</p>
            </>
          )}
          <footer>
            <Button onClick={() => leave.request(close, !!preview || !!busy || unknown)}>
              取消
            </Button>
            {unknown ? (
              <Button variant="primary" disabled={!!busy} onClick={() => void save()}>
                重试原请求
              </Button>
            ) : (
              <Button
                variant="primary"
                disabled={
                  !!busy ||
                  !preview ||
                  !selected.length ||
                  choices.some((value) => selected.includes(value.key) && !value.name.trim())
                }
                onClick={() => void save()}
              >
                导入为草稿{selected.length ? ` (${selected.length})` : ''}
              </Button>
            )}
          </footer>
        </div>
      </Modal>
      {leave.dialog}
    </>
  );
}
