import { useId } from 'react';
import { Button } from '../workbench/Button.js';
import { Field } from '../workbench/controls.js';
import { useUnsavedChanges } from '../workbench/UnsavedChanges.js';
import type { ExecutionApi, ExecutionNodeWire } from './ExecutionApi.js';
import { nodeIdentity, useFormKey } from './interaction.js';
import { UpstreamInputsPanel } from './UpstreamInputsPanel.js';
import { useDeliveryEditor } from './useDeliveryEditor.js';

type Props = {
  api: ExecutionApi;
  node: ExecutionNodeWire;
  mode?: 'submit' | 'revise';
  onSubmitted(node: ExecutionNodeWire): void;
};
export function DeliveryPanel(props: Props) {
  const key = useFormKey(props.api, nodeIdentity(props.node));
  return <DeliveryForm key={key} {...props} />;
}
function DeliveryForm({ api, node, mode = 'submit', onSubmitted }: Props) {
  const titleId = useId();
  const available =
    mode === 'revise'
      ? node.status === 'needs-revision'
      : ['ready', 'needs-revision'].includes(node.status);
  const editor = useDeliveryEditor(api, node, available, onSubmitted);
  useUnsavedChanges(editor.dirty || !!editor.pending);
  const upstreamBlocked = node.inputs?.some((input) => input.blocking) === true;
  const locked = editor.pending === 'save' || editor.pending === 'submit' || editor.submitted;
  const status = editor.submitted
    ? '已提交，等待待办更新。'
    : editor.pending === 'read'
      ? '正在读取草稿…'
      : editor.pending === 'save'
        ? '正在保存草稿…'
        : editor.pending === 'submit'
          ? '正在提交…'
          : !editor.saved
            ? '草稿尚未读取。'
            : editor.dirty
              ? '有未保存的修改'
              : editor.saved.version === 0
                ? '尚未保存草稿'
                : `${editor.saved.text || editor.saved.links.length || editor.saved.files.length ? '已保存' : '草稿为空'} · 草稿版本 ${editor.saved.version}`;
  return (
    <section className="zm-config-form zm-execution-detail" aria-labelledby={titleId}>
      <div className="zm-page-heading">
        <div>
          <p className="zm-eyebrow">{mode === 'revise' ? '修改后重新提交' : '提交产物'}</p>
          <h2 id={titleId}>{node.goal}</h2>
        </div>
      </div>
      {node.expectedOutput && <p className="zm-execution-hint">交付内容：{node.expectedOutput}</p>}
      <UpstreamInputsPanel inputs={node.inputs} api={api} node={node} />
      {upstreamBlocked && <p role="status">上游输入不可用，暂不能提交；仍可保存草稿。</p>}
      {!available && <p role="status">当前节点已不接受交付，请刷新待办。</p>}
      <p role="status" className="zm-draft-status">
        {status}
      </p>
      {editor.error && (
        <div role="alert" className="zm-error">
          {editor.error}
        </div>
      )}
      {editor.candidate && (
        <section className="zm-draft-recovery" aria-label="已存草稿对照">
          <h3>
            {editor.candidate.version === 0
              ? '当前没有已保存草稿'
              : `已存草稿 · 版本 ${editor.candidate.version}`}
          </h3>
          <details>
            <summary>查看已存内容</summary>
            <div className="zm-draft-preview">
              <p className="zm-execution-text">{editor.candidate.text || '无文字正文'}</p>
              {editor.candidate.links.map((link, i) => (
                <p key={i}>{link}</p>
              ))}
              {editor.candidate.files.map((file, i) => (
                <p key={i}>
                  {file.id} · {file.mediaType} · {file.byteSize} 字节 · 未上传
                </p>
              ))}
            </div>
          </details>
          <div className="zm-actions">
            <Button disabled={!!editor.pending} onClick={() => editor.resolve('restore')}>
              恢复到表单
            </Button>
            <Button disabled={!!editor.pending} onClick={() => editor.resolve('keep')}>
              保留当前输入
            </Button>
            <Button
              variant="quiet"
              disabled={!!editor.pending}
              onClick={() => editor.resolve('cancel')}
            >
              取消恢复
            </Button>
          </div>
        </section>
      )}
      <Field label="产物正文">
        <textarea
          rows={7}
          maxLength={100000}
          disabled={locked}
          value={editor.values.text}
          onChange={(e) => editor.edit('text', e.target.value)}
        />
      </Field>
      <Field label="参考链接（选填，每行一个）">
        <textarea
          rows={2}
          disabled={locked}
          value={editor.values.link}
          onChange={(e) => editor.edit('link', e.target.value)}
        />
      </Field>
      {!!editor.values.files.length && (
        <section className="zm-draft-files" aria-label="未完成的文件引用">
          <h3>未完成的文件引用</h3>
          <p className="zm-muted">保存草稿会保留引用。移除引用后可提交文字或链接。</p>
          <ul>
            {editor.values.files.map((file, i) => (
              <li key={i}>
                <div>
                  <strong>{file.id}</strong>
                  <p>
                    {file.mediaType} · {file.byteSize} 字节 · 未上传
                  </p>
                </div>
                <Button
                  variant="quiet"
                  disabled={!!editor.pending || editor.submitted || !editor.saved}
                  aria-label={`移除文件引用 ${file.id}`}
                  onClick={() => editor.removeFile(i)}
                >
                  移除引用
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="zm-actions">
        <Button
          variant="secondary"
          disabled={!editor.canWrite || !editor.dirty}
          busy={editor.pending === 'save'}
          busyLabel="正在保存…"
          onClick={() => void editor.save()}
        >
          保存草稿
        </Button>
        <Button
          variant="quiet"
          disabled={!!editor.pending || editor.submitted || !available}
          onClick={() => void editor.read()}
        >
          {editor.saved ? '查看已存草稿' : '重试读取草稿'}
        </Button>
        <Button
          variant="primary"
          disabled={!editor.canWrite || upstreamBlocked || !!editor.values.files.length}
          busy={editor.pending === 'submit'}
          busyLabel="正在提交…"
          onClick={() => void editor.submit()}
        >
          {mode === 'revise' ? '重新提交' : '提交产物'}
        </Button>
      </div>
    </section>
  );
}
