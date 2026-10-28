import { useRef, useState, type FormEvent } from 'react';
import type { TeamAsset, Workbench, WorkflowTemplate } from '@zhuma/agent-core';
import type { WorkbenchApi } from './api.js';
import { Field, Modal } from './controls.js';
import { Button } from './Button.js';
import { TemplatePreview } from './TemplatePreview.js';

export function TemplateSaveDialog({
  definition,
  initialName,
  sourceTaskId,
  api,
  revision,
  saved,
  close,
}: {
  definition: WorkflowTemplate;
  initialName: string;
  sourceTaskId?: string;
  api: WorkbenchApi;
  revision: number;
  saved(state: Workbench): void;
  close(): void;
}) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [assetId] = useState(() => crypto.randomUUID());
  const retry = useRef<{ payload: string; id: string; revision: number } | null>(null);
  const submitting = useRef(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setSaving(true);
    setError('');
    const asset: TeamAsset = {
      id: assetId,
      name: name.trim(),
      description,
      kind: 'template',
      content: JSON.stringify(definition),
      available: true,
    };
    const input = {
      templateId: assetId,
      sourceTaskId: sourceTaskId ?? '',
      name: asset.name,
      description,
    };
    const payload = JSON.stringify(api.member ? input : asset);
    if (retry.current?.payload !== payload)
      retry.current = { payload, id: crypto.randomUUID(), revision };
    try {
      if (api.member && (!api.saveTemplate || !sourceTaskId))
        throw new Error('请从已保存的任务中保存工作流。');
      saved(
        api.member && api.saveTemplate
          ? await api.saveTemplate(retry.current.revision, input, retry.current.id)
          : await api.save(retry.current.revision, { type: 'save-asset', asset }, retry.current.id),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败，请重试。');
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }
  return (
    <Modal
      title="保存为工作流"
      close={() => {
        if (!submitting.current) close();
      }}
    >
      <form className="zm-template-save-form" onSubmit={(event) => void submit(event)}>
        <div className="zm-form-body">
          <fieldset disabled={saving}>
            <div className="zm-form-row">
              <Field label="工作流名称">
                <input
                  autoFocus
                  required
                  maxLength={160}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Field label="适用场景">
                <input
                  maxLength={8000}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="例如：接口与调用方并行开发"
                />
              </Field>
            </div>
            <p className="zm-muted">分工保存为角色，使用时再选择本次参与者。</p>
            <div className="zm-template-save-preview">
              <TemplatePreview definition={definition} />
            </div>
          </fieldset>
        </div>
        {error && (
          <div role="alert" className="zm-error">
            {error}
          </div>
        )}
        <footer>
          <Button disabled={saving} onClick={close}>
            取消
          </Button>
          <Button type="submit" variant="primary" busy={saving} busyLabel="正在保存…">
            保存工作流
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
