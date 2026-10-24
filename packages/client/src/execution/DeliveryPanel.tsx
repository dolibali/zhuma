import { useId, useRef, useState } from 'react';
import { Button } from '../workbench/Button.js';
import { Field } from '../workbench/controls.js';
import { useUnsavedChanges } from '../workbench/UnsavedChanges.js';
import type { ExecutionApi, ExecutionNodeWire } from './ExecutionApi.js';
import { nodeIdentity, useExecutionCommand, useFormKey } from './interaction.js';

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
  const [text, setText] = useState('');
  const [link, setLink] = useState('');
  useUnsavedChanges(!!text || !!link);
  const command = useExecutionCommand();
  const context = JSON.stringify([
    nodeIdentity(node),
    node.version,
    node.status,
    node.currentRoundId ?? null,
  ]);
  const presented = useRef(context);
  presented.current = context;
  const attempted = useRef(context);
  const available =
    mode === 'revise'
      ? node.status === 'needs-revision'
      : ['ready', 'needs-revision'].includes(node.status);
  const error = attempted.current === context ? command.error : '';
  function submit() {
    if (!available) return;
    attempted.current = context;
    const links = link
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean);
    if (!text.trim() && !links.length) {
      command.setError('请填写产物正文或添加链接。');
      return;
    }
    if (
      links.length > 20 ||
      links.some((value) => {
        try {
          const url = new URL(value);
          return !['http:', 'https:'].includes(url.protocol) || !!url.username || !!url.password;
        } catch {
          return true;
        }
      })
    ) {
      command.setError('最多添加 20 个 http 或 https 链接，每行一个。');
      return;
    }
    const payload = {
      taskId: node.taskId,
      planId: node.planId,
      revision: node.revision,
      nodeId: node.nodeId,
      expectedVersion: node.version,
      text,
      links,
    };
    void command.run(
      payload,
      (idempotencyKey, signal) => api.submit({ ...payload, idempotencyKey }, signal),
      (next) => {
        if (presented.current !== context) return;
        setText('');
        setLink('');
        onSubmitted(next);
      },
    );
  }
  return (
    <section className="zm-config-form zm-execution-detail" aria-labelledby={titleId}>
      <div className="zm-page-heading">
        <div>
          <p className="zm-eyebrow">{mode === 'revise' ? '修改后重新提交' : '提交产物'}</p>
          <h2 id={titleId}>{node.goal}</h2>
        </div>
      </div>
      {node.expectedOutput && <p className="zm-execution-hint">交付内容：{node.expectedOutput}</p>}
      {!available && <p role="status">当前节点已不接受提交，请刷新待办。</p>}
      {error && (
        <div role="alert" className="zm-error">
          {error}
        </div>
      )}
      <Field label="产物正文">
        <textarea
          rows={7}
          maxLength={100000}
          disabled={command.pending}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </Field>
      <Field label="参考链接（选填，每行一个）">
        <textarea
          rows={2}
          disabled={command.pending}
          value={link}
          onChange={(event) => setLink(event.target.value)}
        />
      </Field>
      <div className="zm-actions">
        <Button
          variant="primary"
          disabled={!available}
          busy={command.pending}
          busyLabel="正在提交…"
          onClick={submit}
        >
          {mode === 'revise' ? '重新提交' : '提交产物'}
        </Button>
      </div>
    </section>
  );
}
