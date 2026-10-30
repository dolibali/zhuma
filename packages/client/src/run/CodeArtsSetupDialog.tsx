import { useEffect, useRef, useState } from 'react';
import { Button } from '../workbench/Button.js';
import { Field, Modal } from '../workbench/controls.js';
import { useLeaveConfirmation } from '../workbench/useLeaveConfirmation.js';
import { useUnsavedChanges } from '../workbench/UnsavedChanges.js';
import type { CodeArtsSetupApi } from './codearts-setup.js';

export function CodeArtsSetupDialog({
  api,
  close,
  changed,
}: {
  api: CodeArtsSetupApi;
  close(): void;
  changed(): Promise<void>;
}) {
  const [command, setCommand] = useState('codearts'),
    [busy, setBusy] = useState(true),
    [configured, setConfigured] = useState<boolean>(),
    [error, setError] = useState(''),
    [dirty, setDirty] = useState(false);
  const lifetime = useRef<AbortController>();
  const leave = useLeaveConfirmation();
  useUnsavedChanges(dirty || busy);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    void api
      .status(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setConfigured(value.configured);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError('无法读取当前配置，仍可输入命令重新保存。');
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [api]);
  async function save() {
    const signal = lifetime.current?.signal;
    if (!signal || busy) return;
    setBusy(true);
    setError('');
    try {
      await api.configure(command, signal);
      signal.throwIfAborted();
      setDirty(false);
      setConfigured(true);
      await changed();
      signal.throwIfAborted();
      close();
    } catch (error) {
      if (!signal.aborted)
        setError(
          `${error instanceof Error ? error.message : '保存结果未确认。'} 可重新保存同一命令。`,
        );
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  return (
    <>
      {leave.dialog}
      <Modal title="配置码道" close={() => leave.request(close, dirty || busy)}>
        <div className="zm-codearts-setup">
          <p>
            {configured === true ? '本机已配置码道，可更换命令。' : '使用本机已安装的码道 CLI。'}
          </p>
          <Field label="码道命令">
            <input
              autoFocus
              value={command}
              disabled={busy}
              placeholder="codearts 或完整可执行文件路径"
              onChange={(event) => {
                setCommand(event.target.value);
                setDirty(true);
              }}
            />
          </Field>
          <small>在码道 CLI 完成登录后，选择码道处理任务。保存配置不会启动任务。</small>
          {error && <p role="alert">{error}</p>}
          <div className="zm-dialog-actions">
            <Button onClick={() => leave.request(close, dirty || busy)}>取消</Button>
            <Button
              variant="primary"
              disabled={busy || !command.trim()}
              onClick={() => void save()}
            >
              {busy ? '正在校验…' : '保存配置'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
