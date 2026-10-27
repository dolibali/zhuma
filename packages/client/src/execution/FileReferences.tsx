import { useEffect, useRef, useState } from 'react';
import { Button } from '../workbench/Button.js';
import { executionErrorMessage, ExecutionError, type ExecutionApi } from './ExecutionApi.js';
import { useFormKey } from './interaction.js';
import type { FileInfo, FileTarget } from './files.js';

type Reference = {
  readonly id: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly checksum?: string;
  readonly uploadComplete?: boolean;
};
type Props = {
  api: Pick<ExecutionApi, 'files'>;
  target: FileTarget;
  files: readonly Reference[];
  names?: readonly { readonly id: string; readonly name: string }[];
  scopeKey?: string;
  remove?: ((index: number) => void) | undefined;
  disabled?: boolean;
};
export function fileSize(bytes: number): string {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KiB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
function FileEntry(props: Omit<Props, 'files'> & { file: Reference; index: number }) {
  const key = useFormKey(props.api, JSON.stringify([props.target, props.scopeKey, props.file]));
  return <OwnedFile key={key} {...props} />;
}
function OwnedFile({
  api,
  target,
  file,
  names,
  index,
  remove,
  disabled,
}: Omit<Props, 'files'> & { file: Reference; index: number }) {
  const [info, setInfo] = useState<FileInfo>();
  const [pending, setPending] = useState<'metadata' | 'preview' | 'download'>();
  const [preview, setPreview] = useState<string>();
  const [downloadOnly, setDownloadOnly] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState('');
  const active = useRef<AbortController>();
  const alive = useRef(false);
  const urls = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const query = { ...target, uploadId: file.id };
  const name = info?.name || names?.find((item) => item.id === file.id)?.name || '文件';
  function matches(value: FileInfo) {
    if (
      value.uploadId !== file.id ||
      value.bytes !== file.byteSize ||
      value.mediaType !== file.mediaType ||
      (file.checksum && value.sha256 !== file.checksum)
    )
      throw new ExecutionError('validation', '文件信息与当前版本不一致，请刷新。');
  }
  async function run(mode: 'metadata' | 'preview' | 'download') {
    if (!alive.current || !api.files || active.current || file.uploadComplete === false) return;
    if (mode === 'preview' && preview !== undefined) {
      setPreview(undefined);
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    const current = () =>
      alive.current && active.current === controller && !controller.signal.aborted;
    setPending(mode);
    setError('');
    try {
      if (mode === 'metadata') {
        const value = await api.files.metadata(query, controller.signal);
        if (!current()) return;
        matches(value);
        setInfo(value);
      } else {
        const value = await api.files.read(query, mode, controller.signal);
        if (!current()) return;
        matches(value.info);
        setInfo(value.info);
        if (mode === 'preview') {
          if (value.inline) {
            const limit = 128 * 1024;
            const partial = value.bytes.byteLength > limit;
            setPreview(
              new TextDecoder('utf-8', { fatal: true }).decode(value.bytes.subarray(0, limit), {
                stream: partial,
              }),
            );
            setTruncated(partial);
          } else setDownloadOnly(true);
        } else {
          const url = URL.createObjectURL(
            new Blob([new Uint8Array(value.bytes)], { type: 'application/octet-stream' }),
          );
          const link = document.createElement('a');
          link.href = url;
          link.download = value.info.name;
          document.body.append(link);
          link.click();
          link.remove();
          const timer = setTimeout(() => {
            URL.revokeObjectURL(url);
            urls.current.delete(url);
          }, 30_000);
          urls.current.set(url, timer);
        }
      }
    } catch (error) {
      if (current()) setError(executionErrorMessage(error));
    } finally {
      if (current()) {
        active.current = undefined;
        setPending(undefined);
      }
    }
  }
  useEffect(() => {
    alive.current = true;
    void run('metadata');
    return () => {
      alive.current = false;
      active.current?.abort();
      for (const [url, timer] of urls.current) {
        clearTimeout(timer);
        URL.revokeObjectURL(url);
      }
      urls.current.clear();
    };
  }, []);
  const canPreview =
    /^(text\/|application\/(json|xml|x-yaml|yaml))/i.test(file.mediaType) && !downloadOnly;
  return (
    <li className="zm-file-entry">
      <div className="zm-file-row">
        <div className="zm-file-name">
          <strong>{name}</strong>
          <small>
            {fileSize(file.byteSize)} · {file.mediaType}
          </small>
        </div>
        {file.uploadComplete === false ? (
          <span className="zm-kind">引用未完成</span>
        ) : api.files ? (
          <div className="zm-file-actions">
            {canPreview && (
              <Button
                variant="quiet"
                disabled={!!pending || !info}
                onClick={() => void run('preview')}
              >
                {preview === undefined ? '预览' : '收起预览'}
              </Button>
            )}
            <Button
              variant="quiet"
              disabled={!!pending || !info}
              onClick={() => void run('download')}
            >
              {pending === 'download' ? '正在读取…' : '下载'}
            </Button>
            {!!error && (
              <Button variant="quiet" disabled={!!pending} onClick={() => void run('metadata')}>
                重试
              </Button>
            )}
          </div>
        ) : (
          <span className="zm-muted">文件读取尚未接入</span>
        )}
        {remove && (
          <Button
            variant="quiet"
            disabled={disabled}
            aria-label={`移除文件 ${name}`}
            onClick={() => remove(index)}
          >
            移除
          </Button>
        )}
      </div>
      {pending && (
        <p className="zm-muted" role="status">
          {pending === 'metadata'
            ? '正在读取文件信息…'
            : pending === 'preview'
              ? '正在校验并读取预览…'
              : '正在校验并读取原文件…'}
        </p>
      )}
      {error && (
        <p role="alert" className="zm-error">
          {error}
        </p>
      )}
      {downloadOnly && <p className="zm-muted">此文件请下载查看。</p>}
      {preview !== undefined && truncated && (
        <p className="zm-muted">仅预览前 128 KiB，下载可查看全文。</p>
      )}
      {preview !== undefined && (
        <pre className="zm-file-preview" tabIndex={0} aria-label={`${name} 原文预览`}>
          {preview}
        </pre>
      )}
    </li>
  );
}
export function FileReferences({ files, ...props }: Props) {
  if (!files.length) return null;
  return (
    <ul className="zm-file-list" aria-label="附件">
      {files.map((file, index) => (
        <FileEntry key={file.id} {...props} file={file} index={index} />
      ))}
    </ul>
  );
}
