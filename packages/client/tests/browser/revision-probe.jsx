import { useMemo, useState } from 'react';
import { createExecutionApi } from '../../src/execution/ExecutionApi.js';
import { ExecutionWorkspace } from '../../src/execution/ExecutionWorkspace.js';
import { RevisionWorkspace } from '../../src/execution/RevisionWorkspace.js';
import { returnedNode, revisionItem, revisionView } from '../revision-fixture.mjs';

// Response replay only. Deliberately ignores abort, to exercise late-result protection.
export function RevisionProbe() {
  const [generation, setGeneration] = useState(0);
  const [node, setNode] = useState(returnedNode);
  const direct = new URL(location.href).searchParams.has('revision-direct');
  const control = useMemo(() => {
    const value = {
      calls: [],
      events: [],
      node: returnedNode,
      view: revisionView(),
      holdReads: false,
      holdSubmits: false,
      update(next) {
        value.node = next;
        setNode(next);
      },
      replaceSession() {
        setGeneration((n) => n + 1);
      },
      complete(index, outcome = 'success') {
        const call = value.calls[index];
        if (outcome === 'reject') call.reject(Error('late replay failure'));
        else if (outcome === 'failure')
          call.resolve({
            ok: false,
            error: {
              code: 'not-returned',
              message: '该节点目前不在退回修改阶段。',
              details: {},
            },
          });
        else call.resolve(call.response);
      },
    };
    value.api = createExecutionApi({
      call(channel, endpoint, payload, signal) {
        const read = endpoint.endsWith('/revision');
        const submit = endpoint.endsWith('/submit');
        const response = {
          ok: true,
          value: endpoint.endsWith('/draft')
            ? { version: 0, text: '', links: [], files: [] }
            : read
              ? { view: structuredClone(value.view) }
              : submit
                ? {
                    node: {
                      ...value.node,
                      version: value.node.version + 1,
                      status: 'in-review',
                      currentRoundId: 'resubmitted-round',
                      rounds: [
                        {
                          id: 'resubmitted-round',
                          status: 'open',
                          artifactVersionId: 'artifact-v3',
                          reviewerIds: ['lin', 'qa'],
                          ballots: [],
                        },
                      ],
                    },
                  }
                : { actorId: 'chen', nodes: [value.node], items: [revisionItem] },
        };
        const call = { channel, endpoint, payload, signal, response };
        value.calls.push(call);
        return (read && value.holdReads) || (submit && value.holdSubmits)
          ? new Promise((resolve, reject) => Object.assign(call, { resolve, reject }))
          : Promise.resolve(response);
      },
    });
    window.revisionProbe = value;
    return value;
  }, [generation]);
  return (
    <div className="zhuma">
      <main className="zm-page">
        <p className="zm-muted">客户端响应重放 · 不连接真实执行服务</p>
        {direct ? (
          <RevisionWorkspace
            api={control.api}
            node={node}
            onSubmitted={(next) => control.events.push(next)}
          />
        ) : (
          <ExecutionWorkspace api={control.api} />
        )}
      </main>
    </div>
  );
}
