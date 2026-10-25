import { useMemo, useState } from 'react';
import { createExecutionApi, readInboxPlaces } from '../../src/execution/ExecutionApi.js';
import { ExecutionWorkspace } from '../../src/execution/ExecutionWorkspace.js';
import { InboxPanel } from '../../src/execution/InboxPanel.js';
import { groupedInbox } from '../inbox-groups-fixture.mjs';
import { revisionView } from '../revision-fixture.mjs';

export function InboxGroupsProbe() {
  const preview = new URL(location.href).searchParams.has('places-preview');
  const [session, setSession] = useState(0);
  const [, render] = useState(0);
  const c = useMemo(() => {
    const value = {
      data: groupedInbox(),
      calls: [],
      opened: [],
      reloads: 0,
      failInbox: false,
      holdInbox: false,
      complete(index) {
        const call = value.calls[index];
        call.resolve(call.response);
      },
      update(next) {
        value.data = next;
        render((n) => n + 1);
      },
      replaceSession() {
        setSession((n) => n + 1);
      },
    };
    if (session) value.data.nodes[0] = { ...value.data.nodes[0], goal: '新会话待交付工作' };
    value.api = createExecutionApi({
      async call(channel, endpoint, payload, signal) {
        const call = { channel, endpoint, payload, signal };
        value.calls.push(call);
        if (endpoint.endsWith('/inbox')) {
          const response = value.failInbox
            ? {
                ok: false,
                error: { code: 'unavailable', message: '待办暂时无法读取。', details: {} },
              }
            : { ok: true, value: structuredClone(value.data) };
          if (value.holdInbox)
            return new Promise((resolve) => Object.assign(call, { response, resolve }));
          return response;
        }
        if (endpoint.endsWith('/draft'))
          return { ok: true, value: { version: 0, text: '', links: [], files: [] } };
        if (endpoint.endsWith('/revision')) return { ok: true, value: { view: revisionView() } };
        if (endpoint.endsWith('/submit') || endpoint.endsWith('/ballot')) {
          const node = value.data.nodes.find(
            (node) => node.taskId === payload.taskId && node.nodeId === payload.nodeId,
          );
          return { ok: true, value: { node: { ...node, version: node.version + 1 } } };
        }
        throw Error('Unreviewed endpoint is not available in this replay');
      },
    });
    window.inboxGroupsProbe = value;
    return value;
  }, [session]);
  return (
    <div className="zhuma">
      <main className="zm-page">
        <p className="zm-muted">
          {preview ? '来源组件独立预览 · 非真实服务' : '当前执行入口响应重放 · 无真实权限服务'}
        </p>
        {preview ? (
          <InboxPanel
            items={c.data.items}
            nodes={c.data.nodes}
            places={readInboxPlaces(c.data.places)}
            reload={() => c.reloads++}
            open={(item) => c.opened.push(item)}
          />
        ) : (
          <ExecutionWorkspace api={c.api} />
        )}
      </main>
    </div>
  );
}
