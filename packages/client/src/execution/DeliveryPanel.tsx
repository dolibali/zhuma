import { useEffect, useRef, useState } from 'react';
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

const READ_TIMEOUT_MS = 10_000;

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
  const [draftVersion, setDraftVersion] = useState(0);
  const [baselineReady, setBaselineReady] = useState(true);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<'save' | 'submit' | ''>('');
  const key = useRef(crypto.randomUUID());
  const alive = useRef(true);
  const edited = useRef(false);
  const editGeneration = useRef(0);
  const nodeKey = `${node.taskId}:${node.planId}:${node.revision}:${node.nodeId}`;
  const liveNode = useRef(nodeKey);
  liveNode.current = nodeKey;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const savedFor = nodeKey;
    let active = true;
    let timedOut = false;
    edited.current = false;
    editGeneration.current = 0;
    key.current = crypto.randomUUID();
    setText('');
    setLink('');
    setFile(emptyFile);
    setDraftVersion(0);
    setBaselineReady(false);
    setError('');
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, READ_TIMEOUT_MS);
    void api
      .readDeliveryDraft(
        {
          taskId: node.taskId,
          planId: node.planId,
          revision: node.revision,
          nodeId: node.nodeId,
        },
        controller.signal,
      )
      .then(
        (draft) => {
          clearTimeout(timer);
          if (!active || liveNode.current !== savedFor) return;
          setDraftVersion(draft.version);
          setBaselineReady(true);
          if (edited.current) return;
          setText(draft.text);
          setLink(draft.links[0] ?? '');
          const first = draft.files[0];
          setFile(
            first
              ? {
                  id: first.id,
                  mediaType: first.mediaType,
                  byteSize: String(first.byteSize),
                  checksum: first.checksum,
                  accessPolicyId: first.accessPolicyId,
                  uploadComplete: false,
                }
              : emptyFile,
          );
        },
        (caught: unknown) => {
          clearTimeout(timer);
          if (!active || liveNode.current !== savedFor) return;
          if (controller.signal.aborted && !timedOut) return;
          setBaselineReady(true);
          setError(
            timedOut
              ? '草稿没有在时间内读出来。'
              : caught instanceof Error
                ? caught.message
                : '草稿没有读出来。',
          );
        },
      );
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, node.taskId, node.planId, node.revision, node.nodeId, nodeKey]);

  function rotate() {
    edited.current = true;
    editGeneration.current += 1;
    key.current = crypto.randomUUID();
  }

  function stillHere(savedFor: string) {
    return alive.current && liveNode.current === savedFor;
  }

  function listedFiles(): ArtifactFileRef[] | undefined {
    if (file.id.trim() === '') return [];
    const byteSize = Number(file.byteSize);
    if (
      !Number.isInteger(byteSize) ||
      byteSize < 0 ||
      file.mediaType.trim() === '' ||
      file.checksum.trim() === '' ||
      file.accessPolicyId.trim() === ''
    ) {
      setError('请补全文件类型、大小、校验和访问策略。');
      return undefined;
    }
    return [
      {
        id: file.id.trim(),
        mediaType: file.mediaType.trim(),
        byteSize,
        checksum: file.checksum.trim(),
        accessPolicyId: file.accessPolicyId.trim(),
        uploadComplete: false,
      },
    ];
  }

  async function submit() {
    if (file.id.trim() !== '') {
      setError('文件还不能随这次提交完成。请只提交文字或链接。');
      return;
    }
    const files = listedFiles();
    if (files === undefined) return;
    edited.current = true;
    const savedFor = liveNode.current;
    setPending('submit');
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
      if (!stillHere(savedFor)) return;
      rotate();
      setText('');
      setLink('');
      setFile(emptyFile);
      setDraftVersion(0);
      onSubmitted(next);
    } catch (caught) {
      if (!stillHere(savedFor)) return;
      setError(caught instanceof Error ? caught.message : '提交没有完成。');
    } finally {
      if (stillHere(savedFor)) setPending('');
    }
  }

  async function save() {
    const files = listedFiles();
    if (files === undefined) return;
    edited.current = true;
    const generation = editGeneration.current;
    const savedFor = liveNode.current;
    setPending('save');
    setError('');
    try {
      const saved = await api.saveDeliveryDraft({
        taskId: node.taskId,
        planId: node.planId,
        revision: node.revision,
        nodeId: node.nodeId,
        expectedVersion: draftVersion,
        idempotencyKey: key.current,
        files,
        links: link.trim() === '' ? [] : [link.trim()],
        ...(text === '' ? {} : { text }),
      });
      if (!stillHere(savedFor)) return;
      setDraftVersion(saved.version);
      if (editGeneration.current === generation) setText(saved.text);
    } catch (caught) {
      if (!stillHere(savedFor)) return;
      setError(caught instanceof Error ? caught.message : '草稿没有保存。');
    } finally {
      if (stillHere(savedFor)) setPending('');
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
            onChange={(event) => {
              rotate();
              setFile({ ...file, mediaType: event.target.value });
            }}
          />
        </Field>
        <Field label="字节数">
          <input
            inputMode="numeric"
            value={file.byteSize}
            onChange={(event) => {
              rotate();
              setFile({ ...file, byteSize: event.target.value });
            }}
          />
        </Field>
        <Field label="校验">
          <input
            value={file.checksum}
            onChange={(event) => {
              rotate();
              setFile({ ...file, checksum: event.target.value });
            }}
          />
        </Field>
        <Field label="访问策略">
          <input
            value={file.accessPolicyId}
            onChange={(event) => {
              rotate();
              setFile({ ...file, accessPolicyId: event.target.value });
            }}
          />
        </Field>
        <p className="zm-empty">待解析</p>
      </div>
      <div className="zm-actions">
        <Button
          busy={pending === 'save'}
          busyLabel="正在保存…"
          disabled={pending !== '' || !baselineReady}
          onClick={() => void save()}
        >
          保存草稿
        </Button>
        <Button
          busy={pending === 'submit'}
          busyLabel="正在提交…"
          disabled={blocked || pending !== '' || !baselineReady}
          onClick={() => void submit()}
        >
          提交产物
        </Button>
      </div>
    </section>
  );
}
