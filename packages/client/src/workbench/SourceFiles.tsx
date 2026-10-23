import { useEffect, useState } from 'react';
import { packageFileBytes, packageFileText, type PackageFile } from '@zhuma/agent-core';
import type { WorkbenchApi } from './api.js';
import { Modal } from './controls.js';
import { SingleSelect } from './SingleSelect.js';
import { Button } from './Button.js';

export function SourceFiles({ files }: { files: PackageFile[] }) {
  const [path, setPath] = useState(files[0]?.path ?? '');
  const file = files.find((f) => f.path === path) ?? files[0];
  if (!file) return <p className="zm-empty-inline">没有来源文件</p>;
  let text: string | null = null;
  if (/\.(?:md|txt|json|yaml|yml|py|js|ts|sh|csv|xml|html|svg)$/iu.test(file.path)) {
    try {
      text = packageFileText(file);
    } catch {
      /* Binary data remains available for download. */
    }
  }
  return (
    <section className="zm-source-files" aria-label="来源文件">
      <div className="zm-source-toolbar">
        <SingleSelect
          label="选择来源文件"
          value={file.path}
          onValueChange={setPath}
          options={files.map((f) => ({ value: f.path, label: f.path }))}
        />
        <span className="zm-muted">{packageFileBytes(file).toLocaleString()} B</span>
        <Button
          onClick={() => {
            const bytes = Uint8Array.from(atob(file.data), (s) => s.charCodeAt(0));
            const url = URL.createObjectURL(
              new Blob([bytes], { type: 'application/octet-stream' }),
            );
            const link = document.createElement('a');
            link.href = url;
            link.download = file.path.split('/').at(-1)!;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        >
          下载文件
        </Button>
      </div>
      {text === null ? (
        <p className="zm-empty-inline">此文件可下载查看。</p>
      ) : (
        <>
          <pre tabIndex={0}>{text.slice(0, 60000)}</pre>
          {text.length > 60000 && (
            <small className="zm-muted">预览前 60000 字符，可下载完整文件。</small>
          )}
        </>
      )}
    </section>
  );
}

export function ResourceSourceDialog({
  kind,
  id,
  name,
  versionId,
  api,
  close,
}: {
  kind: 'asset' | 'expert';
  id: string;
  name: string;
  versionId: string;
  api: WorkbenchApi;
  close(): void;
}) {
  const [files, setFiles] = useState<PackageFile[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void api.resourceFiles(kind, id, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return;
        if (result.versionId !== versionId) {
          setError('来源版本已变化，请刷新目录再查看。');
          return;
        }
        setFiles(result.files);
      },
      (e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : '读取失败，请重试。');
      },
    );
    return () => controller.abort();
  }, [api, kind, id, versionId]);
  return (
    <Modal title={`来源文件 · ${name}`} close={close}>
      <div className="zm-source-dialog-body">
        {error ? (
          <p role="alert" className="zm-error">
            {error}
          </p>
        ) : files ? (
          <SourceFiles files={files} />
        ) : (
          <p role="status">正在读取来源…</p>
        )}
      </div>
      <footer>
        <Button onClick={close}>关闭</Button>
      </footer>
    </Modal>
  );
}
