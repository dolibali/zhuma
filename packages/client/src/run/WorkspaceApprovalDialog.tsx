import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../workbench/Button.js';
import { Field, Modal } from '../workbench/controls.js';
import { ExecutionError, executionErrorMessage } from '../execution/ExecutionApi.js';
import { useExecutionCommand, useFormKey } from '../execution/interaction.js';
import {
  workspacePublishRanges,
  type WorkspaceApprovalApi,
  type WorkspaceApprovalLocation,
  type WorkspaceApprovalView,
  type WorkspacePublishRange,
} from './workspace-approvals.js';

type Props = {
  api: WorkspaceApprovalApi;
  location: WorkspaceApprovalLocation;
  close(): void;
  changed(): void | Promise<void>;
  returnLabel?: string | undefined;
};
/** Remount on the actual API/member generation, even when project ids repeat. */
export function WorkspaceApprovalDialog(props: Props) {
  const key = useFormKey(props.api, JSON.stringify(props.location));
  return <Dialog key={key} {...props} />;
}
function Dialog({ api, location, close, changed, returnLabel = '关闭' }: Props) {
  const fixed = useRef(location).current;
  const [view, setView] = useState<WorkspaceApprovalView>();
  const [context, setContext] = useState<{
    readonly accountName: string;
    readonly projectName: string;
  }>();
  const [selected, select] = useState('');
  const [access, setAccess] = useState<'read' | 'write'>('read');
  const [publish, setPublish] = useState<WorkspacePublishRange[]>([]);
  const [loading, setLoading] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(false);
  const reader = useRef<AbortController>();
  const picker = useRef<AbortController>();
  const command = useExecutionCommand();
  const directory = view?.directories.find((item) => item.id === selected);
  const approval = view?.approvals.find((item) => item.workspaceId === selected);
  const busy = loading || picking || command.pending;
  const refresh = useCallback(
    async (workspaceId?: string) => {
      reader.current?.abort();
      const request = new AbortController();
      reader.current = request;
      const current = () => alive.current && reader.current === request && !request.signal.aborted;
      setLoading(true);
      setError('');
      setContext(undefined);
      try {
        if (!api.context)
          throw new ExecutionError('unavailable', '暂时无法确认授权范围，请刷新后重试。');
        const [value, scope] = await Promise.all([
          api.options(fixed, request.signal),
          api.context(fixed, request.signal),
        ]);
        if (!current()) return;
        if (!scope.accountName.trim() || !scope.projectName.trim())
          throw new ExecutionError('validation', '授权范围不完整，请刷新后重试。');
        setContext(scope);
        setView(value);
        if (workspaceId) select(workspaceId);
      } catch (caught) {
        if (current()) setError(executionErrorMessage(caught));
      } finally {
        if (current()) setLoading(false);
      }
    },
    [api, fixed],
  );
  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
      reader.current?.abort();
      picker.current?.abort();
    };
  }, [refresh]);
  useEffect(() => {
    setAccess(approval?.access ?? 'read');
    setPublish((approval?.publish ?? []).map((item) => ({ ...item })));
    command.setError('');
  }, [selected, approval?.generation]);
  async function pick() {
    if (!api.pickDirectory || busy || !context) return;
    const request = new AbortController();
    picker.current = request;
    setPicking(true);
    setError('');
    try {
      const id = await api.pickDirectory(request.signal);
      if (!alive.current || picker.current !== request || request.signal.aborted) return;
      if (id) await refresh(id);
    } catch (caught) {
      if (alive.current && !request.signal.aborted) setError(executionErrorMessage(caught));
    } finally {
      if (alive.current && picker.current === request && !request.signal.aborted) setPicking(false);
    }
  }
  const updated = async () => {
    await refresh();
    try {
      if (alive.current) await changed();
    } catch (caught) {
      if (alive.current) setError(executionErrorMessage(caught));
    }
  };
  function approve() {
    if (!directory || !view?.available || !context || busy) return;
    let ranges: WorkspacePublishRange[];
    try {
      ranges = workspacePublishRanges(publish);
    } catch {
      command.setError('文件交付范围请填写相对路径，例如 deliverables 或 report.md。');
      return;
    }
    const input = {
      ...fixed,
      workspaceId: directory.id,
      expectedGeneration: approval?.generation ?? 0,
      access,
      publish: ranges,
    };
    void command.run(
      input,
      (requestId, signal) => api.approve({ ...input, requestId }, signal),
      (current) => {
        void updated();
        if (current.status === 'revoked') command.setError('该授权已被撤销，请刷新后重新确认。');
      },
    );
  }
  function revoke(id: string, generation: number) {
    if (busy || !context) return;
    const input = { ...fixed, approvalId: id, expectedGeneration: generation };
    void command.run(
      input,
      (requestId, signal) => api.revoke({ ...input, requestId }, signal),
      () => void updated(),
    );
  }
  return (
    <Modal title="工作目录授权" close={close}>
      <div className="zm-workspace-approval">
        {context ? (
          <dl className="zm-workspace-scope" aria-label="授权范围">
            <div>
              <dt>项目</dt>
              <dd>{context.projectName}</dd>
            </div>
            <div>
              <dt>账号</dt>
              <dd>{context.accountName}</dd>
            </div>
          </dl>
        ) : (
          <p className="zm-muted" role="status">
            {loading ? '正在核对项目与账号…' : '暂时无法确认授权范围。'}
          </p>
        )}
        <div className="zm-workspace-approval-toolbar">
          <div>
            <Button variant="quiet" disabled={busy} onClick={() => void refresh()}>
              刷新
            </Button>
            {api.pickDirectory && (
              <Button
                busy={picking}
                disabled={loading || command.pending || !context}
                onClick={() => void pick()}
              >
                选择本机目录
              </Button>
            )}
          </div>
        </div>
        {loading && !view && <p role="status">正在读取工作目录…</p>}
        {view && (
          <>
            {!view.available && (
              <p className="zm-error" role="status">
                目录服务暂不可用，仍可撤销已有授权。
              </p>
            )}
            <Field label="目录">
              <select
                value={selected}
                disabled={busy || !view.available || !context}
                onChange={(event) => select(event.target.value)}
              >
                <option value="">选择已登记目录</option>
                {view.directories.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
            </Field>
            {directory && (
              <>
                <p className="zm-workspace-path" title={directory.path}>
                  {directory.path}
                </p>
                <Field label="Agent 权限">
                  <select
                    value={access}
                    disabled={busy}
                    onChange={(event) =>
                      setAccess(event.target.value === 'write' ? 'write' : 'read')
                    }
                  >
                    <option value="read">只读</option>
                    <option value="write" disabled={directory.access !== 'write'}>
                      读写
                    </option>
                  </select>
                </Field>
                <section className="zm-workspace-publish" aria-label="文件交付范围">
                  <header>
                    <h3>文件交付范围</h3>
                    <Button
                      variant="quiet"
                      disabled={busy || publish.length >= 16}
                      onClick={() => setPublish([...publish, { kind: 'directory', path: '' }])}
                    >
                      添加范围
                    </Button>
                  </header>
                  {!publish.length && <p className="zm-muted">尚未允许把本机文件交付给团队。</p>}
                  {publish.map((range, index) => (
                    <div className="zm-workspace-publish-row" key={index}>
                      <select
                        aria-label={`范围类型 ${index + 1}`}
                        value={range.kind}
                        disabled={busy}
                        onChange={(event) =>
                          setPublish(
                            publish.map((item, at) =>
                              at === index
                                ? {
                                    ...item,
                                    kind: event.target.value === 'file' ? 'file' : 'directory',
                                  }
                                : item,
                            ),
                          )
                        }
                      >
                        <option value="directory">目录</option>
                        <option value="file">文件</option>
                      </select>
                      <input
                        aria-label={`相对路径 ${index + 1}`}
                        maxLength={512}
                        value={range.path}
                        placeholder="deliverables/report.md"
                        disabled={busy}
                        onChange={(event) =>
                          setPublish(
                            publish.map((item, at) =>
                              at === index ? { ...item, path: event.target.value } : item,
                            ),
                          )
                        }
                      />
                      <Button
                        variant="quiet"
                        disabled={busy}
                        aria-label={`移除范围 ${index + 1}`}
                        onClick={() => setPublish(publish.filter((_, at) => at !== index))}
                      >
                        移除
                      </Button>
                    </div>
                  ))}
                </section>
                <Button
                  variant="primary"
                  busy={command.pending}
                  disabled={
                    loading ||
                    picking ||
                    !context ||
                    !view.available ||
                    (access === 'write' && directory.access !== 'write')
                  }
                  onClick={approve}
                >
                  {approval?.status === 'approved' ? '更新授权' : '授权目录'}
                </Button>
              </>
            )}
            <section className="zm-workspace-approved" aria-label="已有授权">
              <h3>已有授权</h3>
              {!view.approvals.some((item) => item.status === 'approved') && (
                <p className="zm-muted">尚无可用授权，可继续仅使用任务材料。</p>
              )}
              {view.approvals
                .filter((item) => item.status === 'approved')
                .map((item) => (
                  <div key={item.id} className="zm-workspace-approved-row">
                    <span>
                      <strong>
                        {view.directories.find((directory) => directory.id === item.workspaceId)
                          ?.title ?? '目录暂不可用'}
                      </strong>
                      <small>
                        {item.access === 'write' ? '读写' : '只读'} ·{' '}
                        {item.publish.length
                          ? `${item.publish.length} 项文件交付范围`
                          : '不交付本机文件'}
                      </small>
                    </span>
                    <Button
                      variant="danger"
                      disabled={busy || !context}
                      onClick={() => revoke(item.id, item.generation)}
                    >
                      撤销
                    </Button>
                  </div>
                ))}
            </section>
          </>
        )}
        {(error || command.error) && (
          <p className="zm-error" role="alert">
            {error || command.error}
          </p>
        )}
      </div>
      <footer>
        <Button onClick={close}>{returnLabel}</Button>
      </footer>
    </Modal>
  );
}
