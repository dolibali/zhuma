import { useId, useState } from 'react';
import { Button } from '../workbench/Button.js';
import { Field } from '../workbench/controls.js';
import type { ExecutionApi, ExecutionNodeWire } from './ExecutionApi.js';
import { nodeIdentity, useExecutionCommand, useFormKey } from './interaction.js';

type Props = {
  api: ExecutionApi;
  node: ExecutionNodeWire;
  onSubmitted(node: ExecutionNodeWire): void;
};

export function DeliveryPanel(props: Props) {
  const key = useFormKey(props.api, nodeIdentity(props.node));
  return <DeliveryForm key={key} {...props} />;
}
function DeliveryForm({ api, node, onSubmitted }: Props) {
  const titleId = useId();
  const [text, setText] = useState('');
  const [link, setLink] = useState('');
  const command = useExecutionCommand();
  function submit() {
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
          <p className="zm-eyebrow">提交产物</p>
          <h2 id={titleId}>{node.goal}</h2>
        </div>
      </div>
      {node.expectedOutput && <p className="zm-execution-hint">交付内容：{node.expectedOutput}</p>}
      {command.error && (
        <div role="alert" className="zm-error">
          {command.error}
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
        <Button variant="primary" busy={command.pending} busyLabel="正在提交…" onClick={submit}>
          提交产物
        </Button>
      </div>
    </section>
  );
}
