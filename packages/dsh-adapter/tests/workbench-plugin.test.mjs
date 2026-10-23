import assert from 'node:assert/strict';
import test from 'node:test';
import { openWorkbench } from '../dist/workbench-plugin.js';
import { apply as applyHost } from '../dist/host-plugin.js';
import { configureDeploymentMode } from '../dist/member-session.js';
import { fixture } from '../../../tests/fixtures/workbench.mjs';
import {
  packageFixture,
  importCommand as packageCommand,
} from '../../../tests/fixtures/asset-package.mjs';
import { previewResourcePackage, parseWorkflowTemplate } from '@zhuma/agent-core';

async function mount(mode = 'legacy-single-user') {
  const routes = new Map();
  const audits = new Map();
  const effects = [];
  const opened = [];
  const packages = new Map();
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
        opened.push(spec.name);
        if (spec.name === 'zhuma_asset_packages') {
          assert.equal(spec.layout, 'per-record');
          return {
            close() {},
            table: (name) => {
              assert.equal(name, 'versions');
              return {
                get: (id) => packages.get(id),
                put: async (id, value) => {
                  packages.set(id, value);
                },
              };
            },
          };
        }
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
  if (mode !== null) configureDeploymentMode(ctx, mode);
  const { readWorkbench } = await openWorkbench(ctx);
  async function request(endpoint, payload, method = `zhuma/${endpoint}`) {
    return routes.get(`/api/zhuma/${endpoint}`).fetch(
      new Request(`http://localhost/api/zhuma/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'test', method, payload }),
      }),
    );
  }
  return { routes, request, effects, opened, readWorkbench };
}

test('Host mode contract: absent/invalid explicit config rejects before service access; public config cannot carry account verifiers', async () => {
  for (const config of [
    undefined,
    {},
    { deploymentMode: 'owner' },
    { deploymentMode: 'multi-member', identityImport: { accounts: [] } },
    { deploymentMode: 'legacy-single-user', bodyBytes: 0 },
    { deploymentMode: 'multi-member', identityBootstrapKey: 'invalid-key' },
  ]) {
    await assert.rejects(applyHost({}, config));
  }
});

test('Host exact gates: all five reject before touching body, even with identity unmounted or mode unset', async () => {
  for (const [mode, status] of [
    ['multi-member', 404],
    [null, 401],
  ]) {
    const { routes, effects } = await mount(mode);
    let reads = 0;
    for (const route of routes.values()) {
      assert.equal(route.requestBody, 'streaming');
      const request = new Request('http://localhost/api/zhuma/snapshot', {
        method: 'POST',
        body: 'not-json',
      });
      Object.defineProperty(request, 'body', {
        get() {
          reads++;
          throw Error('denied body must remain unread');
        },
      });
      assert.equal((await route.fetch(request)).status, status);
    }
    assert.equal(reads, 0);
    for (const dispose of effects) await dispose();
  }
});

test('Host internal workbench seam: one open per domain, cloned snapshot, revoked after disposal', async () => {
  const { readWorkbench, effects, opened } = await mount();
  const first = readWorkbench();
  first.projects[0].name = 'A caller mutation';
  assert.notEqual(readWorkbench().projects[0].name, first.projects[0].name);
  assert.deepEqual(opened, ['zhuma_workbench', 'zhuma_asset_packages']);
  for (const dispose of effects) await dispose();
  assert.throws(readWorkbench, /已关闭/);
});

test('Host route contract: exact authenticated carrier contribution, protocol identity and error redaction', async () => {
  const { routes, request, effects, opened } = await mount();
  assert.deepEqual(opened, ['zhuma_workbench', 'zhuma_asset_packages']);
  assert.deepEqual(
    [...routes.keys()],
    ['snapshot', 'command', 'plan', 'preview-import', 'resource-files'].map(
      (e) => `/api/zhuma/${e}`,
    ),
  );
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

test('Host import route contract: preview is read-only; source queries return just the selected definition files', async () => {
  const { request, effects } = await mount();
  const source = packageFixture();
  const preview = await (await request('preview-import', { kind: 'files', files: source })).json();
  assert.equal(preview.result.ok, true);
  assert.equal(preview.result.value.items.length, 2);
  const before = await (await request('snapshot', {})).json();
  assert.equal(before.result.value.state.revision, 0);
  const command = packageCommand(previewResourcePackage(source, parseWorkflowTemplate), source);
  const imported = await (
    await request('command', { requestId: crypto.randomUUID(), expectedRevision: 0, command })
  ).json();
  assert.equal(imported.result.ok, true);
  const expert = await (
    await request('resource-files', { kind: 'expert', id: 'imported-1' })
  ).json();
  assert.equal(expert.result.value.files.length, 3);
  assert(
    !expert.result.value.files.some(
      (f) => f.path.includes('skills/') || f.path.endsWith('USER.md'),
    ),
  );
  const missing = await (
    await request('resource-files', { kind: 'expert', id: 'not-an-expert' })
  ).json();
  assert.equal(missing.result.error.code, 'not-found');
  for (const dispose of effects) await dispose();
});
