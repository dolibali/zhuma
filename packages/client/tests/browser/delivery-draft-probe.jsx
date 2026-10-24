import { useMemo, useState } from 'react';
import { createExecutionApi } from '../../src/execution/ExecutionApi.js';
import { DeliveryPanel } from '../../src/execution/DeliveryPanel.js';
import { RevisionWorkspace } from '../../src/execution/RevisionWorkspace.js';
import { ExecutionWorkspace } from '../../src/execution/ExecutionWorkspace.js';
import { deliveryNode, inbox } from './execution-fixture.mjs';
import { returnedNode, revisionView } from '../revision-fixture.mjs';
import { savedDraft } from '../delivery-draft-fixture.mjs';

// Explicit response replay. No real storage, authorization or execution state machine.
export function DeliveryDraftProbe() {
  const params = new URL(location.href).searchParams;
  const revise = params.has('draft-revise'),
    direct = params.has('draft-direct');
  const [session, setSession] = useState(0);
  const [node, setNode] = useState(revise ? returnedNode : deliveryNode);
  const control = useMemo(() => {
    const initial = savedDraft();
    if (!params.has('draft-files')) initial.files = [];
    if (params.has('draft-empty'))
      Object.assign(initial, { version: 0, text: '', links: [], files: [] });
    if (session) initial.text = '新会话的草稿';
    const c = {
      node,
      draft: initial,
      calls: [],
      events: [],
      holdRead: params.has('draft-hold'),
      holdSave: false,
      holdSubmit: false,
      updateNode(next) {
        c.node = next;
        setNode(next);
      },
      replaceSession() {
        setSession((n) => n + 1);
      },
      complete(index, outcome = 'success') {
        const call = c.calls[index];
        if (outcome === 'failure')
          call.resolve({
            ok: false,
            error: { code: 'unavailable', message: '保存暂不可用，请重试。', details: {} },
          });
        else if (outcome === 'conflict')
          call.resolve({
            ok: false,
            error: {
              code: 'conflict',
              message: '草稿已变化，请读取已存草稿。',
              details: { currentVersion: c.draft.version },
            },
          });
        else if (outcome === 'malformed') call.resolve({ ok: true, value: {} });
        else if (outcome === 'reject') call.reject(Error('Replay transport failure'));
        else {
          if (call.kind === 'save') c.draft = structuredClone(call.response.value);
          if (outcome === 'lost') call.reject(Error('Replay response lost'));
          else call.resolve(call.response);
        }
      },
    };
    c.api = createExecutionApi({
      call(channel, endpoint, payload, signal) {
        const kind = endpoint.endsWith('/draft')
          ? 'idempotencyKey' in payload
            ? 'save'
            : 'read'
          : endpoint.endsWith('/submit')
            ? 'submit'
            : 'other';
        const value =
          kind === 'read'
            ? structuredClone(c.draft)
            : kind === 'save'
              ? {
                  version: payload.expectedVersion + 1,
                  text: payload.text ?? '',
                  links: [...(payload.links ?? [])],
                  files: structuredClone(payload.files ?? []),
                }
              : kind === 'submit'
                ? { node: { ...c.node, version: c.node.version + 1, status: 'in-review' } }
                : endpoint.endsWith('/revision')
                  ? { view: revisionView() }
                  : inbox([c.node]);
        const entry = { kind, channel, endpoint, payload, signal, response: { ok: true, value } };
        c.calls.push(entry);
        return new Promise((resolve, reject) => {
          Object.assign(entry, { resolve, reject });
          if (
            !(kind === 'read'
              ? c.holdRead
              : kind === 'save'
                ? c.holdSave
                : kind === 'submit'
                  ? c.holdSubmit
                  : false)
          )
            c.complete(c.calls.length - 1);
        });
      },
    });
    window.deliveryDraftProbe = c;
    return c;
  }, [session]);
  return (
    <div className="zhuma">
      <main className="zm-page">
        <p className="zm-muted">草稿客户端响应重放 · 无真实存储或上传</p>
        {direct ? (
          revise ? (
            <RevisionWorkspace
              api={control.api}
              node={node}
              onSubmitted={(next) => control.events.push(next)}
            />
          ) : (
            <DeliveryPanel
              api={control.api}
              node={node}
              onSubmitted={(next) => control.events.push(next)}
            />
          )
        ) : (
          <ExecutionWorkspace api={control.api} />
        )}
      </main>
    </div>
  );
}
