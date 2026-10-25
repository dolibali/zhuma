import { useMemo, useState } from 'react';
import { createExecutionApi } from '../../src/execution/ExecutionApi.js';
import { ExecutionWorkspace } from '../../src/execution/ExecutionWorkspace.js';
import { deliveryNode, inbox } from './execution-fixture.mjs';
import { returnedNode, revisionView } from '../revision-fixture.mjs';
import { upstreamInputs } from '../upstream-input-fixture.mjs';
import { upstreamContent } from '../upstream-content-fixture.mjs';

// Response replay for the normal inbox -> delivery/revise entry, never an authorization service.
export function UpstreamProbe() {
  const [session, setSession] = useState(0);
  const revise = new URL(location.href).searchParams.get('upstream-mode') === 'revise';
  const control = useMemo(() => {
    const value = {
      calls: [],
      node: { ...(revise ? returnedNode : deliveryNode), inputs: upstreamInputs().slice(0, 3) },
      holdInbox: false,
      denySubmit: false,
      holdContent: false,
      denyContent: false,
      contentText: '订单接口约定\n缺少状态筛选时保持旧返回结构。',
      replaceSession() {
        setSession((n) => n + 1);
      },
      complete(index) {
        const call = value.calls[index];
        call.resolve(call.response);
      },
    };
    value.api = createExecutionApi(
      {
        call(channel, endpoint, payload, signal) {
          const response = endpoint.endsWith('/upstream-content')
            ? value.denyContent
              ? {
                  ok: false,
                  error: { code: 'not-found', message: '来源版本已不可读取。', details: {} },
                }
              : {
                  ok: true,
                  value: {
                    ...upstreamContent(payload),
                    content: { ...upstreamContent(payload).content, text: value.contentText },
                  },
                }
            : endpoint.endsWith('/submit') && value.denySubmit
              ? {
                  ok: false,
                  error: {
                    code: 'upstream-unavailable',
                    message: '上游来源已不可用，请刷新待办。',
                    details: {},
                  },
                }
              : {
                  ok: true,
                  value: endpoint.endsWith('/inbox')
                    ? { ...inbox([structuredClone(value.node)]), spaceId: 'team-a' }
                    : endpoint.endsWith('/draft')
                      ? { version: 0, text: '', links: [], files: [] }
                      : endpoint.endsWith('/revision')
                        ? { view: revisionView() }
                        : {
                            node: {
                              ...value.node,
                              version: value.node.version + 1,
                              status: 'in-review',
                            },
                          },
                };
          const call = { channel, endpoint, payload, signal, response };
          value.calls.push(call);
          // Ignore abort on purpose: old-context data must not be presented even for a late transport.
          return (endpoint.endsWith('/inbox') && value.holdInbox) ||
            (endpoint.endsWith('/upstream-content') && value.holdContent)
            ? new Promise((resolve) => Object.assign(call, { resolve }))
            : Promise.resolve(response);
        },
      },
      'team-a',
    );
    window.upstreamProbe = value;
    return value;
  }, [session, revise]);
  return (
    <div className="zhuma">
      <main className="zm-page">
        <p className="zm-muted">客户端响应重放 · 无真实权限或文件服务</p>
        <ExecutionWorkspace api={control.api} />
      </main>
    </div>
  );
}
