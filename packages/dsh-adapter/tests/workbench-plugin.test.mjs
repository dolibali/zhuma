import assert from 'node:assert/strict';
import test from 'node:test';
import { apply } from '../dist/workbench-plugin.js';
import { fixture } from '../../../tests/fixtures/workbench.mjs';

async function mount() {
  const routes = new Map();
  const audits = new Map();
  const effects = [];
  let state = fixture().state;
  const ctx = {
    effect(callback) {
      const dispose = callback();
      effects.push(dispose);
    },
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route);
        },
      },
    },
    storageDomain: {
      async open(spec) {
        assert.equal(spec.name, 'zhuma_workbench');
        return {
          close() {},
          global: {
            get: () => state,
            set: async (value) => {
              state = value;
            },
          },
          table: () => ({
            get: (id) => audits.get(id),
            put: async (id, value) => {
              audits.set(id, value);
            },
            keys: () => audits.keys(),
            delete: (id) => audits.delete(id),
          }),
        };
      },
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
    },
    llm: {
      prepareCall: async () => {
        throw new Error('secret-provider-value');
      },
    },
  };
  await apply(ctx);
  async function request(endpoint, payload, method = `zhuma/${endpoint}`) {
    return routes.get(`/api/zhuma/${endpoint}`).fetch(
      new Request(`http://localhost/api/zhuma/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'test', method, payload }),
      }),
    );
  }
  return { routes, request, effects };
}

test('Host route contract: exact authenticated carrier contribution, protocol identity and error redaction', async () => {
  const { routes, request, effects } = await mount();
  assert.equal(routes.size, 3);
  assert.equal((await request('snapshot', {}, 'zhuma/command')).status, 400);
  const response = await (await request('snapshot', {})).json();
  assert.equal(response.type, 'server-response');
  assert.equal(response.rpcId, 'test');
  assert.equal(response.result.value.state.tasks.length, 1);
  const failed = await (
    await request('plan', {
      requestId: crypto.randomUUID(),
      expectedRevision: 0,
      taskId: 'task',
      instruction: '',
    })
  ).json();
  assert.equal(failed.result.ok, false);
  assert.equal(failed.result.error.code, 'unavailable');
  assert.ok(!JSON.stringify(failed).includes('secret-provider-value'));
  for (const dispose of effects) await dispose();
  const stopped = await (await request('snapshot', {})).json();
  assert.equal(stopped.result.error.code, 'cancelled');
});
