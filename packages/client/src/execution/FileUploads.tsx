import { useEffect, useId, useRef, useState, type DragEvent } from 'react';
import { Button } from '../workbench/Button.js';
import { executionErrorMessage, type ExecutionApi, type RevisionQuery } from './ExecutionApi.js';
import { FILE_LIMITS, type FileUploadReceipt } from './files.js';
import { fileSize } from './FileReferences.js';

type Upload = {
  id: string;
  file: File;
  state: 'queued' | 'preparing' | 'uploading' | 'failed' | 'cancelled';
  message?: string | undefined;
  controller?: AbortController | undefined;
};
type Props = {
  api: ExecutionApi;
  target: RevisionQuery;
  count: number;
  disabled: boolean;
  onUploaded(receipt: FileUploadReceipt): boolean;
  onPresence(present: boolean): void;
  onBusy(busy: boolean): void;
};
/** Local file carriers only; durable completion comes exclusively from a validated Host receipt. */
export function FileUploads(props: Props) {
  const id = useId();
  const [uploads, setUploads] = useState<readonly Upload[]>([]);
  const [error, setError] = useState('');
  const [over, setOver] = useState(false);
  const current = useRef<readonly Upload[]>([]);
  const callbacks = useRef(props);
  callbacks.current = props;
  const alive = useRef(false);
  const working = useRef(false);
  function publish(next: readonly Upload[]) {
    if (!alive.current) return;
    current.current = next;
    setUploads(next);
    callbacks.current.onPresence(next.length > 0);
    callbacks.current.onBusy(
      next.some((item) => ['queued', 'preparing', 'uploading'].includes(item.state)),
    );
  }
  const change = (id: string, patch: Partial<Upload>) =>
    publish(current.current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  async function drain() {
    if (working.current || !alive.current || !callbacks.current.api.files) return;
    working.current = true;
    try {
      while (alive.current && !callbacks.current.disabled) {
        const item = current.current.find((item) => item.state === 'queued');
        if (!item) break;
        const controller = new AbortController();
        change(item.id, { state: 'preparing', controller, message: undefined });
        try {
          const receipt = await callbacks.current.api.files!.upload(
            { target: callbacks.current.target, file: item.file, requestId: item.id },
            controller.signal,
            (state) => {
              if (!controller.signal.aborted) change(item.id, { state });
            },
          );
          if (
            !alive.current ||
            controller.signal.aborted ||
            !current.current.some((row) => row.id === item.id)
          )
            continue;
          if (!callbacks.current.onUploaded(receipt))
            throw Error('Current delivery cannot accept the file');
          publish(current.current.filter((row) => row.id !== item.id));
        } catch (error) {
          if (!alive.current || !current.current.some((row) => row.id === item.id)) continue;
          change(item.id, {
            state: controller.signal.aborted ? 'cancelled' : 'failed',
            controller: undefined,
            message: controller.signal.aborted
              ? '已取消等待；可用原文件重试确认结果。'
              : executionErrorMessage(error),
          });
        }
      }
    } finally {
      working.current = false;
    }
  }
  function add(files: File[]) {
    if (props.disabled || !props.api.files) return;
    setError('');
    if (files.length + props.count + current.current.length > FILE_LIMITS.count) {
      setError('一次交付最多添加 20 个文件。');
      return;
    }
    if (files.some((file) => file.size > FILE_LIMITS.bytes)) {
      setError('单个文件不能超过 20 MiB。');
      return;
    }
    publish([
      ...current.current,
      ...files.map((file) => ({ id: crypto.randomUUID(), file, state: 'queued' as const })),
    ]);
    void drain();
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const item of current.current) item.controller?.abort();
      callbacks.current.onPresence(false);
      callbacks.current.onBusy(false);
    };
  }, []);
  useEffect(() => {
    if (!props.disabled || !alive.current) return;
    for (const item of current.current) item.controller?.abort();
    publish(
      current.current.map((item) =>
        ['queued', 'preparing', 'uploading'].includes(item.state)
          ? {
              ...item,
              state: 'cancelled' as const,
              controller: undefined,
              message: '当前工作项暂不能上传，恢复后可用原文件重试。',
            }
          : item,
      ),
    );
  }, [props.disabled]);
  function drag(event: DragEvent) {
    if (!props.disabled && event.dataTransfer.types.includes('Files')) {
      event.preventDefault();
      setOver(true);
    }
  }
  return (
    <section className="zm-file-upload" aria-label="添加交付文件">
      <div
        className="zm-file-drop"
        data-over={over}
        onDragOver={drag}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          add([...event.dataTransfer.files]);
        }}
      >
        <input
          id={id}
          type="file"
          multiple
          disabled={props.disabled}
          onChange={(event) => {
            add([...(event.target.files ?? [])]);
            event.target.value = '';
          }}
        />
        <label htmlFor={id} aria-disabled={props.disabled}>
          添加文件
        </label>
        <span className="zm-muted">或拖放到这里 · 每个最多 20 MiB</span>
      </div>
      {error && (
        <p className="zm-error" role="alert">
          {error}
        </p>
      )}
      {!!uploads.length && (
        <ul className="zm-file-list" aria-label="上传队列">
          {uploads.map((item) => (
            <li key={item.id} className="zm-file-entry">
              <div className="zm-file-row">
                <div className="zm-file-name">
                  <strong>{item.file.name}</strong>
                  <small>{fileSize(item.file.size)}</small>
                </div>
                <span role="status">
                  {
                    {
                      queued: '等待上传',
                      preparing: '准备文件',
                      uploading: '上传并校验中',
                      failed: '未确认完成',
                      cancelled: '已取消等待',
                    }[item.state]
                  }
                </span>
                {['queued', 'preparing', 'uploading'].includes(item.state) ? (
                  <>
                    <progress aria-label={`${item.file.name} 上传中`} />
                    <Button
                      variant="quiet"
                      onClick={() => {
                        if (item.controller) item.controller.abort();
                        else publish(current.current.filter((row) => row.id !== item.id));
                      }}
                    >
                      取消
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      variant="quiet"
                      disabled={props.disabled}
                      onClick={() => {
                        change(item.id, { state: 'queued' });
                        void drain();
                      }}
                    >
                      重试
                    </Button>
                    <Button
                      variant="quiet"
                      onClick={() => publish(current.current.filter((row) => row.id !== item.id))}
                    >
                      移除
                    </Button>
                  </>
                )}
              </div>
              {item.message && <p className="zm-muted">{item.message}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
