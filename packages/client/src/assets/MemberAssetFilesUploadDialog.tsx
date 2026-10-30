import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { MEMBER_ASSET_LIMITS } from '@zhuma/agent-core';
import type { MemberSpaceLifetime } from '../identity/MemberSpaceBoundary.js';
import { Modal } from '../workbench/controls.js';
import { Button } from '../workbench/Button.js';
import { useLeaveConfirmation } from '../workbench/useLeaveConfirmation.js';
import { useUnsavedChanges } from '../workbench/UnsavedChanges.js';
import type { MemberAssetApi } from './api.js';
import {
  MemberAssetFilesUploadQueue,
  type MemberAssetFilesUploadPhase,
} from './MemberAssetFilesUploadQueue.js';

export interface MemberAssetFilesUploadDialogProps {
  api: Pick<MemberAssetApi, 'command' | 'read' | 'upload'>;
  spaceId: string;
  lifetime: MemberSpaceLifetime;
  close(): void;
  onChanged?(): void;
}
const labels: Record<MemberAssetFilesUploadPhase, string> = {
  queued: '等待上传',
  hashing: '正在校验文件摘要…',
  creating: '正在创建草稿…',
  uploading: '正在上传文件…',
  checking: '正在核对回执…',
  complete: '已上传 · 草稿',
  failed: '未完成',
  unknown: '结果待核对',
  cancelling: '正在核对取消结果…',
  'cancel-unknown': '取消结果待核对',
  cancelled: '已取消上传 · 草稿保留',
  stopped: '已停止本地队列',
};

/** One ordinary file per original asset draft. A owns mounting and styling;
 * this leaf never publishes, invokes models, or stores File objects on disk. */
export function MemberAssetFilesUploadDialog(props: MemberAssetFilesUploadDialogProps) {
  const latest = useRef(props);
  latest.current = props;
  const [queue, setQueue] = useState<MemberAssetFilesUploadQueue>();
  useLayoutEffect(() => {
    const originalLifetime = props.lifetime;
    const owner = new MemberAssetFilesUploadQueue({
      api: props.api,
      spaceId: props.spaceId,
      isCurrent: () => originalLifetime.isCurrent() && latest.current.lifetime.isCurrent(),
      onChanged: () => latest.current.onChanged?.(),
    });
    setQueue(owner);
    return () => owner.dispose();
  }, [props.api, props.spaceId]);
  return queue ? <FilesUploadForm queue={queue} close={props.close} /> : null;
}
function FilesUploadForm({ queue, close }: { queue: MemberAssetFilesUploadQueue; close(): void }) {
  const value = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
  const input = useRef<HTMLInputElement>(null),
    descriptionId = useId();
  const [error, setError] = useState('');
  const leave = useLeaveConfirmation(queue.isCurrent);
  useUnsavedChanges(value.dirty);
  const requestClose = () =>
    leave.request(() => {
      queue.dispose();
      close();
    }, value.dirty);
  function add(files: readonly File[]) {
    if (!files.length) return;
    try {
      queue.add(files);
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '文件暂时无法选择。');
    }
  }
  const unresolved = value.rows.some((row) =>
    ['unknown', 'cancel-unknown', 'cancelling'].includes(row.phase),
  );
  return (
    <>
      <Modal title="上传文件资料" close={requestClose} descriptionId={descriptionId}>
        <div className="zm-form zm-member-asset-files-upload">
          <p id={descriptionId}>每个文件保存为独立资产草稿，上传后由你核对并发布。</p>
          <div
            className="zm-member-asset-files-drop"
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = value.running ? 'none' : 'copy';
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (value.running) return;
              if (
                Array.from(event.dataTransfer.items).some(
                  (item) => item.webkitGetAsEntry?.()?.isDirectory,
                )
              ) {
                setError('请选择普通文件，目录请使用资产包导入。');
                return;
              }
              add(Array.from(event.dataTransfer.files));
            }}
          >
            <Button disabled={value.running} onClick={() => input.current?.click()}>
              选择文件
            </Button>
            <span>或将文件拖到这里</span>
            <p className="zm-muted">
              最多 {MEMBER_ASSET_LIMITS.runFiles} 个，总量 20 MiB；按顺序上传。
            </p>
            <input
              ref={input}
              type="file"
              multiple
              hidden
              aria-label="选择批量上传文件"
              disabled={value.running}
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files ?? []);
                event.currentTarget.value = '';
                add(files);
              }}
            />
          </div>
          {error && (
            <div className="zm-error" role="alert">
              {error}
            </div>
          )}
          {value.rows.length > 0 && (
            <>
              <div className="zm-member-asset-files-progress" role="status" aria-live="polite">
                <span>
                  已上传 {value.completed} / {value.rows.length} 个文件
                </span>
                <progress
                  aria-label="已确认上传文件数"
                  value={value.completed}
                  max={value.rows.length}
                />
              </div>
              <ul className="zm-member-asset-files-list" aria-label="待上传文件">
                {value.rows.map((row) => (
                  <li key={row.id}>
                    <div>
                      <strong>{row.name}</strong>
                      <span>{Math.ceil(row.byteSize / 1024)} KB</span>
                    </div>
                    <p>{labels[row.phase]}</p>
                    {row.error && <p className="zm-muted">{row.error}</p>}
                    <div className="zm-actions">
                      {row.phase === 'queued' && (
                        <Button
                          variant="quiet"
                          disabled={value.running}
                          aria-label={`移除 ${row.name}`}
                          onClick={() => queue.remove(row.id)}
                        >
                          移除
                        </Button>
                      )}
                      {[
                        'hashing',
                        'creating',
                        'uploading',
                        'checking',
                        'failed',
                        'unknown',
                      ].includes(row.phase) && (
                        <Button
                          variant="quiet"
                          onClick={() => {
                            void queue.cancel(row.id).catch(() => undefined);
                          }}
                        >
                          停止此项
                        </Button>
                      )}
                      {['failed', 'unknown', 'cancel-unknown'].includes(row.phase) && (
                        <Button
                          disabled={value.running}
                          onClick={() => {
                            void queue.retry(row.id).catch(() => undefined);
                          }}
                        >
                          {row.phase === 'cancel-unknown'
                            ? '重试取消'
                            : row.phase === 'unknown'
                              ? '重试原请求'
                              : '重试'}
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
          <footer>
            <Button onClick={requestClose}>关闭</Button>
            <Button
              variant="primary"
              disabled={
                value.running || unresolved || !value.rows.some((row) => row.phase === 'queued')
              }
              onClick={() => {
                void queue.start().catch(() => undefined);
              }}
            >
              {value.rows.some((row) => row.phase !== 'queued') ? '继续上传其余文件' : '开始上传'}
            </Button>
          </footer>
        </div>
      </Modal>
      {leave.dialog}
    </>
  );
}
