import { useId, useState, type ReactNode } from 'react';
import { Button } from '../workbench/Button.js';
import { Field } from '../workbench/controls.js';
import { useUnsavedChanges } from '../workbench/UnsavedChanges.js';
import type { ExecutionApi, ExecutionNodeWire } from './ExecutionApi.js';
import { nodeIdentity, useFormKey } from './interaction.js';
import { UpstreamInputsPanel } from './UpstreamInputsPanel.js';
import { useDeliveryEditor } from './useDeliveryEditor.js';
import { FileUploads } from './FileUploads.js';
import { FileReferences } from './FileReferences.js';
import { createExecutionGoalView } from '../execution-view.js';

type Props = {
  api: ExecutionApi;
  node: ExecutionNodeWire;
  mode?: 'submit' | 'revise';
  headerAction?: ReactNode;
  onSubmitted(node: ExecutionNodeWire): void;
};
export function DeliveryPanel(props: Props) {
  const key = useFormKey(props.api, nodeIdentity(props.node));
  return <DeliveryForm key={key} {...props} />;
}
function DeliveryForm({ api, node, mode = 'submit', onSubmitted, headerAction }: Props) {
  const titleId = useId();
  const goal = createExecutionGoalView(node.goal);
  const available =
    mode === 'revise'
      ? node.status === 'needs-revision'
      : ['ready', 'needs-revision'].includes(node.status);
  const editor = useDeliveryEditor(api, node, available, onSubmitted);
  const [uploadPresence, setUploadPresence] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  useUnsavedChanges(editor.dirty || !!editor.pending || uploadPresence);
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
          <h2 id={titleId}>{goal.title}</h2>
        </div>
        {headerAction}
      </div>
      {goal.description !== undefined && <p className="zm-execution-text">{goal.description}</p>}
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
                  {editor.candidate?.fileDetails?.find((item) => item.id === file.id)?.name ||
                    file.id}{' '}
                  · {file.mediaType} · {file.byteSize} 字节 ·{' '}
                  {file.uploadComplete ? '已上传' : '引用未完成'}
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
      <Field label={api.files ? '补充说明（选填）' : '产物正文'}>
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
      {api.files && (
        <FileUploads
          key={JSON.stringify([nodeIdentity(node), node.version, node.status, node.currentRoundId])}
          api={api}
          target={node}
          count={editor.values.files.length}
          disabled={!editor.canWrite}
          onUploaded={editor.addFile}
          onPresence={setUploadPresence}
          onBusy={setUploadBusy}
        />
      )}
      <FileReferences
        api={api}
        target={{
          taskId: node.taskId,
          planId: node.planId,
          revision: node.revision,
          nodeId: node.nodeId,
          purpose: 'draft',
        }}
        scopeKey={JSON.stringify([node.version, node.status, node.currentRoundId])}
        files={editor.values.files}
        names={editor.values.names}
        disabled={!!editor.pending || editor.submitted || !editor.saved}
        remove={editor.removeFile}
      />
      {uploadPresence && !uploadBusy && (
        <p className="zm-muted" role="status">
          请重试或移除未完成的上传。
        </p>
      )}
      {editor.incompleteFiles && (
        <p className="zm-muted">移除未完成的引用后可提交；正文和其他附件会保留。</p>
      )}
      <div className="zm-actions">
        <Button
          variant="secondary"
          disabled={!editor.canWrite || !editor.dirty || uploadPresence}
          busy={editor.pending === 'save'}
          busyLabel="正在保存…"
          onClick={() => void editor.save()}
        >
          保存草稿
        </Button>
        <Button
          variant="quiet"
          disabled={!!editor.pending || editor.submitted || !available || uploadPresence}
          onClick={() => void editor.read()}
        >
          {editor.saved ? '查看已存草稿' : '重试读取草稿'}
        </Button>
        <Button
          variant="primary"
          disabled={!editor.canWrite || upstreamBlocked || editor.incompleteFiles || uploadPresence}
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
