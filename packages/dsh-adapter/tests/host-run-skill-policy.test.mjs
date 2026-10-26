import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  applyWorkbenchCommand,
  canonicalPayload,
  createNodeHandoffs,
  startAppliedPlan,
} from '@zhuma/agent-core';
import { WorkbenchService } from '../dist/workbench-service.js';
import { createHostRunSkillPolicies } from '../dist/host-run-skill-policy.js';
import { fixture } from '../../../tests/fixtures/workbench.mjs';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const version = '5dacd4d7-61f6-479e-9973-25b6621b8204';
const original = (flags) =>
  `---\nname: demo\ndescription: Demonstration\n${flags}\n---\nDo the selected work.\n`;

// The real package importer, immutable package shape and core plan mapping run
// here. Member authorization is an explicit contract double, not a live Host.
async function setup(flags = '', { manual = false, raw } = {}) {
  const source = fixture();
  const h = { state: source.state, packages: new Map(), packageReads: [], authorizations: 0 };
  const service = new WorkbenchService(
    {
      read: () => h.state,
      write: async (next) => {
        h.state = next;
      },
    },
    { get: () => undefined, put: async () => {} },
    {
      get: (id) => h.packages.get(id),
      put: async (item) => {
        h.packages.set(item.versionId, item);
      },
    },
  );
  if (!manual) {
    const files = [
      { path: 'demo/SKILL.md', data: Buffer.from(raw ?? original(flags)).toString('base64') },
    ];
    await service.command(
      {
        requestId: 'import',
        expectedRevision: 0,
        command: {
          type: 'import-package',
          input: {
            versionId: version,
            files,
            choices: [
              {
                key: 'demo/SKILL.md',
                id: 'api-skill',
                replace: true,
                name: '接口规范',
                description: '设计 API',
                role: '',
                capabilities: [],
                available: true,
              },
            ],
          },
        },
      },
      new AbortController().signal,
    );
  }
  h.state = applyWorkbenchCommand(h.state, {
    type: 'save-task',
    task: { ...h.state.tasks[0], status: 'ready' },
  });
  h.plan = h.state.appliedPlans.at(-1);
  const started = startAppliedPlan({
    requested: { taskId: 'task', planId: h.plan.id, revision: h.plan.revision },
    applied: h.plan,
    actorId: 'chen',
    existing: [],
  });
  assert.equal(started.ok, true);
  h.node = started.records[0];
  h.request = { headers: {} };
  h.locator = {
    taskId: 'task',
    planId: h.plan.id,
    revision: h.plan.revision,
    nodeId: h.node.nodeId,
    spaceId: 'north',
  };
  h.signal = new AbortController();
  h.authorize = async () => ({ ok: true, value: { ...h.locator, actorId: 'chen', items: [] } });
  h.options = {
    execution: {
      readRunNode: () => h.node,
      async readRunCompositionInputs(request, locator) {
        assert.equal(request, h.request);
        assert.deepEqual(locator, h.locator);
        h.authorizations++;
        return h.authorize(h.authorizations);
      },
    },
    readWorkbench: () => h.state,
    readPackage: (id) => {
      h.packageReads.push(id);
      return h.packages.get(id);
    },
    signal: h.signal.signal,
  };
  h.producer = createHostRunSkillPolicies(h.options);
  h.read = () => h.producer.read(h.request, h.locator);
  h.qualify = () => h.producer.qualify(h.request, h.locator);
  return h;
}
const denied = (promise) => assert.rejects(promise, { code: 'run-authority-unavailable' });

for (const [flags, expected] of [
  ['', [true, true]],
  ['disable-model-invocation: true\nuser-invocable: false', [false, false]],
  ['disable-model-invocation: true\nuser-invocable: true', [false, true]],
  ['disable-model-invocation: false\nuser-invocable: false', [true, false]],
  ['disable-model-invocation: 1\nuser-invocable: 0', [false, false]],
  ['disable-model-invocation: 0\nuser-invocable: 1', [true, true]],
  ['disable-model-invocation: YES\nuser-invocable: off', [false, false]],
  ['disable-model-invocation: No\nuser-invocable: ON', [true, true]],
  ['disable-model-invocation: "FALSE"\nuser-invocable: "false"', [true, false]],
])
  test(`Host policy contract: official static invocation semantics ${JSON.stringify(flags)}`, async () => {
    const h = await setup(flags);
    const [policy] = await h.read();
    assert.deepEqual(policy.invocation, {
      modelInvocable: expected[0],
      userInvocable: expected[1],
    });
    assert.deepEqual(policy.ref, { id: 'api-skill', version: h.plan.id });
    assert.notEqual(policy.ref.version, version);
    assert.equal(
      policy.definitionDigest,
      createHash('sha256').update(canonicalPayload(h.plan.assets[0])).digest('hex'),
    );
    assert.deepEqual(policy.policySource, {
      kind: 'asset-package',
      versionId: version,
      digest: h.packages.get(version).digest,
      entryPath: 'demo/SKILL.md',
    });
    assert.deepEqual(h.packageReads, [version]);
    assert.equal(h.authorizations, 2);
    assert.equal(Object.isFrozen(policy.invocation), true);
  });

test('Host policy contract: defaults apply only to a manual definition without origin', async () => {
  const h = await setup('', { manual: true });
  const [policy] = await h.read();
  assert.deepEqual(policy.policySource, { kind: 'manual-default' });
  assert.deepEqual(policy.invocation, { modelInvocable: true, userInvocable: true });
  assert.deepEqual(h.packageReads, []);
});

test('Host policy qualification: normal command revisions and latest assets do not replace or invalidate fixed origins', async () => {
  const h = await setup();
  const qualified = await h.qualify();
  h.node.command.version++;
  h.state.assets[0].content = 'Latest content is not the saved definition';
  assert.equal(qualified.assertCurrent(), undefined);
  assert.equal(Object.isFrozen(qualified.policies), true);
  assert.equal(h.authorizations, 2, 'synchronous source checks never reenter the write queue');
});

test('Host policy qualification: lost original bytes, changed getters, changed fixed plans and close invalidate issued metadata', async () => {
  for (const change of [
    (h) => h.packages.delete(version),
    (h) => {
      h.packages.get(version).files[0].data = Buffer.from(
        original('user-invocable: false'),
      ).toString('base64');
    },
    (h) => {
      h.options.readPackage = () => h.packages.get(version);
    },
    (h) => {
      h.plan.assets[0].content = 'changed frozen definition';
    },
    (h) => h.signal.abort(),
  ]) {
    const h = await setup();
    const qualified = await h.qualify();
    change(h);
    assert.throws(qualified.assertCurrent, { code: 'run-authority-unavailable' });
  }
});

test('Host policy contract: latest global definitions and packages cannot replace the selected frozen origin', async () => {
  const h = await setup('disable-model-invocation: true');
  h.state.assets[0].content = 'Changed current body';
  h.state.assets[0].origin = {
    ...h.state.assets[0].origin,
    versionId: '4305c554-4faa-4fbe-96eb-e7705a9c1cb7',
  };
  const policy = (await h.read())[0];
  assert.equal(policy.policySource.versionId, version);
  assert.equal(policy.invocation.modelInvocable, false);
  assert.deepEqual(h.packageReads, [version]);
});

test('Host policy contract: denial, wrong scope and hidden inputs reject before package access', async () => {
  for (const authorize of [
    async () => ({ ok: false, code: 'not-found' }),
    async () => ({ ok: true, value: { actorId: 'chen', spaceId: 'other', items: [] } }),
  ]) {
    const h = await setup();
    h.authorize = authorize;
    await denied(h.read());
    assert.deepEqual(h.packageReads, []);
  }
  const h = await setup();
  h.authorize = async () => ({
    ok: true,
    value: { ...h.locator, actorId: 'chen', items: [{ access: 'hidden', blocking: true }] },
  });
  await denied(h.read());
  assert.deepEqual(h.packageReads, []);
});

test('Host policy contract: revocation, actor change, node mutation and shutdown during final authorization never publish policy', async () => {
  for (const change of [
    (h) => ({ ok: false, code: 'not-found' }),
    (h) => ({ ok: true, value: { ...h.locator, actorId: 'other', items: [] } }),
    (h) => {
      h.node.command.version++;
      return { ok: true, value: { ...h.locator, actorId: 'chen', items: [] } };
    },
    (h) => {
      h.node.handoff.goal = 'changed';
      return { ok: true, value: { ...h.locator, actorId: 'chen', items: [] } };
    },
    (h) => {
      h.signal.abort();
      return { ok: true, value: { ...h.locator, actorId: 'chen', items: [] } };
    },
  ]) {
    const h = await setup();
    h.authorize = async (count) =>
      count === 2 ? change(h) : { ok: true, value: { ...h.locator, actorId: 'chen', items: [] } };
    await denied(h.read());
  }
});

test('Host policy contract: missing, changed, duplicate and foreign package facts fail closed', async () => {
  for (const change of [
    (h) => h.packages.clear(),
    (h) => {
      h.packages.get(version).files[0].data = Buffer.from(
        original('user-invocable: false'),
      ).toString('base64');
    },
    (h) => {
      h.packages.get(version).versionId = '4305c554-4faa-4fbe-96eb-e7705a9c1cb7';
    },
    (h) => {
      const p = h.packages.get(version);
      p.files.push({ ...p.files[0] });
      p.digest = hash(p.files);
    },
    (h) => {
      h.plan.assets[0].origin.entryPath = 'absent/SKILL.md';
    },
    (h) => {
      h.plan.assets[0].origin.format = 'openclaw';
    },
    (h) => {
      h.plan.assets[0].origin.filePaths.push('missing.txt');
    },
    (h) => {
      h.plan.assets[0].origin.totalBytes++;
    },
    (h) => {
      h.node.handoff.skillRefs[0].version = 'another-plan';
    },
    (h) => {
      h.node.handoff.skillRefs.push({ ...h.node.handoff.skillRefs[0] });
    },
  ]) {
    const h = await setup();
    change(h);
    await denied(h.read());
  }
});

test('Host policy contract: unselected package is not read', async () => {
  const h = await setup();
  h.plan.task.workflows[0].nodes[0].skillIds = [];
  h.node.handoff = createNodeHandoffs(h.plan)[0];
  assert.deepEqual(await h.read(), []);
  assert.deepEqual(h.packageReads, []);
});

test('Host policy contract: imported invalid/legacy flags are never treated as absent', async () => {
  for (const flags of [
    'disable-model-invocation: maybe',
    'user-invocable: null',
    'user-invocable: 2',
    'user-invocable: [false]',
    'user-invocable: { value: false }',
    'user-invocable: " false "',
    'disableModelInvocation: false',
    'modelInvocable: true',
    'userInvocable: true',
  ]) {
    const h = await setup(flags);
    await denied(h.read());
  }
});

test('Host policy contract: malformed original bytes, duplicate keys, aliases and tags are rejected even if the record digest matches', async () => {
  for (const text of [
    'No frontmatter',
    original('user-invocable: true\nuser-invocable: false'),
    original('user-invocable: &flag false\nmetadata: { copied: *flag }'),
    original('user-invocable: !!str false'),
    original('user-invocable: !exec false'),
    '---\n[]\n---\nBody',
    '---\nname: demo\n---\nBody',
  ]) {
    const h = await setup();
    const p = h.packages.get(version);
    p.files[0].data = Buffer.from(text).toString('base64');
    p.digest = hash(p.files);
    h.plan.assets[0].origin.totalBytes = Buffer.byteLength(text);
    await denied(h.read());
  }
});
