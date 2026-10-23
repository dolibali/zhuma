import { useRef, useState } from 'react';
import type { ArtifactFileRef } from '@zhuma/agent-core';
import { Button } from '../workbench/Button.js';
import { Field } from '../workbench/controls.js';
import type { ExecutionApi, ExecutionNodeWire, UpstreamInputWire } from './ExecutionApi.js';

function UpstreamInputs({ inputs }: { inputs: readonly UpstreamInputWire[] }) {
  return (
    <div className="zm-config-group">
      <strong>上游来源</strong>
      {!inputs.length && <p className="zm-empty">没有已接受的上游产物。</p>}
      {inputs.map((item, index) => {
        if (item.access === 'visible') {
          return (
            <article className="zm-review" key={`${item.sourceNodeId}:${index}`}>
              <p>
                <span className="zm-kind">来源节点</span> {item.sourceNodeId}
                {item.sourceGoal ? ` · ${item.sourceGoal}` : ''}
              </p>
              <p>
                <span className="zm-kind">版本</span> {item.version}
              </p>
              <p>
                <span className="zm-kind">产物</span> {item.name}
              </p>
            </article>
          );
        }
        if (item.access === 'pending') {
          return (
            <p className="zm-empty" key={`${item.sourceNodeId}:${index}`}>
              {item.message}
            </p>
          );
        }
        return (
          <p className="zm-error" key={`hidden:${index}`}>
            {item.message}
          </p>
        );
      })}
    </div>
  );
}

const emptyFile = {
  id: '',
  mediaType: 'text/plain',
  byteSize: '',
  checksum: '',
  accessPolicyId: '',
  uploadComplete: false,
};

export function DeliveryPanel({
  api,
  node,
  onSubmitted,
}: {
  api: ExecutionApi;
  node: ExecutionNodeWire;
  onSubmitted(node: ExecutionNodeWire): void;
}) {
  const [text, setText] = useState('');
  const [link, setLink] = useState('');
  const [file, setFile] = useState(emptyFile);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const key = useRef(crypto.randomUUID());

  function rotate() {
    key.current = crypto.randomUUID();
  }

  async function submit() {
    const files: ArtifactFileRef[] = [];
    if (file.id.trim() !== '') {
      const byteSize = Number(file.byteSize);
      if (
        !Number.isInteger(byteSize) ||
        byteSize < 0 ||
        file.mediaType.trim() === '' ||
        file.checksum.trim() === '' ||
        file.accessPolicyId.trim() === ''
      ) {
        setError('请补全文件类型、大小、校验和访问策略。');
        return;
      }
      files.push({
        id: file.id.trim(),
        mediaType: file.mediaType.trim(),
        byteSize,
        checksum: file.checksum.trim(),
        accessPolicyId: file.accessPolicyId.trim(),
        uploadComplete: file.uploadComplete,
      });
    }
    setPending(true);
    setError('');
    try {
      const next = await api.submit({
        taskId: node.taskId,
        planId: node.planId,
        revision: node.revision,
        nodeId: node.nodeId,
        expectedVersion: node.version,
        idempotencyKey: key.current,
        files,
        links: link.trim() === '' ? [] : [link.trim()],
        ...(text.trim() === '' ? {} : { text }),
      });
      rotate();
      setText('');
      setLink('');
      setFile(emptyFile);
      onSubmitted(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '提交没有完成。');
    } finally {
      setPending(false);
    }
  }

  const blocked = (node.inputs ?? []).some((item) => item.blocking);

  return (
    <section className="zm-config-form" aria-labelledby="zhuma-delivery-title">
      <h2 id="zhuma-delivery-title">提交交付</h2>
      <p>
        <span className="zm-kind">目标</span> {node.goal || '未填写目标'}
      </p>
      <small>期望产出：{node.expectedOutput || '未填写'}</small>
      <UpstreamInputs inputs={node.inputs ?? []} />
      {error && (
        <div role="alert" className="zm-error">
          {error}
        </div>
      )}
      <Field label="交付说明">
        <textarea
          rows={5}
          value={text}
          onChange={(event) => {
            rotate();
            setText(event.target.value);
          }}
        />
      </Field>
      <Field label="链接">
        <input
          value={link}
          onChange={(event) => {
            rotate();
            setLink(event.target.value);
          }}
        />
      </Field>
      <div className="zm-config-group">
        <strong>文件信息</strong>
        <small>只登记已经上传的文件信息。这个页面不保存文件内容。</small>
        <Field label="文件标识">
          <input
            value={file.id}
            onChange={(event) => {
              rotate();
              setFile({ ...file, id: event.target.value });
            }}
          />
        </Field>
        <Field label="媒体类型">
          <input
            value={file.mediaType}
            onChange={(event) => setFile({ ...file, mediaType: event.target.value })}
          />
        </Field>
        <Field label="字节数">
          <input
            inputMode="numeric"
            value={file.byteSize}
            onChange={(event) => setFile({ ...file, byteSize: event.target.value })}
          />
        </Field>
        <Field label="校验">
          <input
            value={file.checksum}
            onChange={(event) => setFile({ ...file, checksum: event.target.value })}
          />
        </Field>
        <Field label="访问策略">
          <input
            value={file.accessPolicyId}
            onChange={(event) => setFile({ ...file, accessPolicyId: event.target.value })}
          />
        </Field>
        <label className="zm-member">
          <input
            type="checkbox"
            checked={file.uploadComplete}
            onChange={(event) => setFile({ ...file, uploadComplete: event.target.checked })}
          />
          <span>文件已经上传完成</span>
        </label>
      </div>
      <div className="zm-actions">
        <Button
          busy={pending}
          busyLabel="正在提交…"
          disabled={blocked}
          onClick={() => void submit()}
        >
          提交产物
        </Button>
      </div>
    </section>
  );
}
