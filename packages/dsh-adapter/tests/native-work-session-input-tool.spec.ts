/** Full-patch native components + existing B reader; identity/catalog/Run remain contracts. */
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import {
  boot,
  grant,
  message,
  ScriptedAdapter,
  allHistory,
  acceptedFixture,
  acceptedInputRef,
  registerNativeAcceptedInputTool,
  toolResponse,
} from './zhuma-native-work-bundle.ts';

async function domainBytes(root) {
  const files = {};
  async function walk(path, prefix = '') {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = join(prefix, entry.name);
      if (entry.isDirectory()) await walk(join(path, entry.name), name);
      else files[name] = (await readFile(join(path, entry.name))).toString('base64');
    }
  }
  await walk(join(root, 'domains'));
  return files;
}

async function setup(t, configure = {}) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-input-tool-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const input = await acceptedFixture();
  const current = grant(input.scope);
  const reads = [];
  let resolutions = 0;
  const ports = {
    catalog: input.catalog,
    resolveCurrentCaller: async (signal) => {
      assert.equal(signal.aborted, false);
      resolutions++;
      return input.caller;
    },
    reader: {
      upstreamContent: async (caller, body) => {
        reads.push(structuredClone(body));
        return input.service.upstreamContent(caller, body);
      },
    },
  };
  configure.ports?.(ports, input, current);
  let host;
  const compose = (ctx, binding, received) => {
    const result = registerNativeAcceptedInputTool(ctx, binding, received, host.service, ports);
    configure.compose?.(ctx, current);
    return result;
  };
  host = await boot(root, new ScriptedAdapter([]), compose);
  t.onTestFinished(() => host.close());
  const ref = acceptedInputRef(current.scope, input.catalog.inputs[0].input);
  const agent = () => host.ctx.agents.get(host.service.open(current).binding.nativeSessionId);
  let request = 0;
  async function invoke(args) {
    host.adapter.script.push(toolResponse(args, `read-${++request}`), 'Tool result received');
    await host.service.send(current, message(`turn-${request}`, 'Read selected input'));
    await agent().whenIdle();
    const events = await allHistory(host.service, current);
    const result = events.filter((event) => event.type === 'tool/result').at(-1);
    assert.ok(result, JSON.stringify(events));
    return JSON.parse(result.data.message.content[0].text);
  }
  return {
    root,
    host,
    input,
    current,
    ports,
    ref,
    invoke,
    reads,
    resolutions: () => resolutions,
    agent,
  };
}

test('actual native model/tool loop reads selected Unicode text and links from the existing B service', async (t) => {
  const h = await setup(t);
  const before = h.input.snapshot();
  const text = await h.invoke({ inputRef: h.ref, part: 'text' });
  assert.equal(text.ok, true);
  assert.equal(text.text, '😀汉'.repeat(2048));
  assert.deepEqual(text.range, {
    offset: 0,
    returned: 4096,
    total: 10000,
    hasMore: true,
    nextOffset: 4096,
  });
  const links = await h.invoke({ inputRef: h.ref, part: 'links' });
  assert.equal(links.links.length, 5);
  assert.equal(links.range.nextOffset, 5);
  assert.equal(links.range.hasMore, true);
  assert.equal(links.source.artifactVersionId, h.input.catalog.inputs[0].input.artifactVersionId);
  assert.equal(h.reads.length, 2);
  assert.equal(h.resolutions(), 4, 'fresh caller before and after each B read');
  assert.ok(h.reads.every((body) => body.sourceNodeId === 'source-1'));
  assert.equal(h.input.snapshot(), before, 'existing execution records are read-only');
  const firstRequest = JSON.stringify(h.host.adapter.requests[0]);
  assert.ok(
    firstRequest.includes(acceptedInputRef(h.current.scope, h.input.catalog.inputs[2].input)),
  );
  for (const body of ['😀汉', 'Unselected source 2', 'Unselected source 3', 'reference-1-0'])
    assert.equal(firstRequest.includes(body), false, body);
  const binding = h.host.service.open(h.current).binding;
  assert.equal(binding.inputReadBudget.attempts, 2);
  assert.ok(binding.inputReadBudget.chargedBytes < 24576);
  assert.equal(binding.receipts.length, 2);
  assert.equal(JSON.stringify(binding).includes('😀'), false);
});

test('actual native tool rejects extra identity/path/source arguments and invalid ranges before source I/O', async (t) => {
  const h = await setup(t);
  const base = { inputRef: h.ref, part: 'text' };
  for (const extra of [
    { actorId: 'outside' },
    { path: '/unrelated' },
    { sourceNodeId: 'source-2' },
    { limit: 4097 },
    { offset: -1 },
    { offset: 1.5 },
  ]) {
    assert.deepEqual(await h.invoke({ ...base, ...extra }), {
      ok: false,
      code: 'invalid-arguments',
    });
  }
  assert.deepEqual(await h.invoke({ ...base, inputRef: `input_${'a'.repeat(64)}` }), {
    ok: false,
    code: 'input-unavailable',
  });
  assert.equal(h.reads.length, 0);
  assert.equal(h.resolutions(), 0);
  assert.equal(h.host.service.open(h.current).binding.inputReadBudget.attempts, 7);
});

test('actual native unpublished setup rejects unexpected scope-local tools and hides unselected globals', async (t) => {
  const definition = {
    name: 'unexpected',
    description: 'Must never run',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: async () => {
      assert.fail('unexpected tool ran');
    },
  };
  const bad = await setup(t, {
    compose(ctx) {
      ctx.tools.register(definition);
    },
  });
  await assert.rejects(
    bad.host.service.send(bad.current, message('reject-local', 'Must not publish')),
    { code: 'invalid-request' },
  );
  assert.equal(bad.host.ctx.agents.list().length, 0);
  assert.equal(bad.host.adapter.requests.length, 0);
  assert.equal(bad.reads.length, 0);
  const h = await setup(t);
  h.host.ctx.tools.register(definition);
  assert.equal((await h.invoke({ inputRef: h.ref, part: 'text', limit: 1 })).ok, true);
  assert.deepEqual(
    h.host.adapter.requests[0].tools.map((tool) => tool.name),
    ['read_accepted_input'],
  );
});

test('actual native monotonic guard rejects authority revoked by an earlier extensible pre-policy', async (t) => {
  const h = await setup(t, {
    compose(ctx, current) {
      ctx.on('tools/pre-execute', async () => {
        current.deny();
        return { kind: 'allow' };
      });
    },
  });
  h.host.adapter.script.push(toolResponse({ inputRef: h.ref, part: 'text', limit: 1 }));
  // The pre-policy may revoke after native admission but before the send's
  // final receipt check. That rejection is correct, not an execution success.
  await h.host.service.send(h.current, message('pre-policy-revoke', 'Read')).catch((error) => {
    assert.match(String(error), /contract-currentness-rejected/);
  });
  await h.host.ctx.agents.list()[0].whenIdle();
  h.current.assertCurrent = () => {};
  const events = await allHistory(h.host.service, h.current);
  const result = events.find((event) => event.type === 'tool/result');
  assert.ok(result);
  assert.equal(h.reads.length, 0);
  assert.deepEqual(JSON.parse(result.data.message.content[0].text), {
    ok: false,
    code: 'cancelled',
  });
});

test('actual native finalizer refuses post-policy value replacement instead of leaking uncharged content', async (t) => {
  const h = await setup(t, {
    compose(ctx) {
      ctx.on('tools/post-execute', async (_exec, result) => ({
        kind: 'accept',
        value: { ...result.value, text: 'replacement-body-must-not-leak' },
      }));
    },
  });
  assert.deepEqual(await h.invoke({ inputRef: h.ref, part: 'text', limit: 1 }), {
    ok: false,
    code: 'input-unavailable',
  });
  const events = await allHistory(h.host.service, h.current);
  assert.equal(JSON.stringify(events).includes('replacement-body-must-not-leak'), false);
});

test('actual native late global/scoped registrations never execute outside the declared allowlist', async (t) => {
  let scoped;
  let executions = 0;
  const h = await setup(t, {
    compose(ctx) {
      scoped = ctx;
    },
  });
  assert.equal((await h.invoke({ inputRef: h.ref, part: 'text', limit: 1 })).ok, true);
  const tool = (name) => ({
    name,
    description: 'Unapproved late registration',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: async () => {
      executions++;
      return 'forbidden-body';
    },
  });
  h.host.ctx.tools.register(tool('late-global'));
  h.host.adapter.script.push(function* () {
    scoped.tools.register(tool('late-scoped'));
    yield* toolResponse({}, 'late-call', 'late-scoped')();
  });
  await h.host.service.send(h.current, message('late-registration', 'Read'));
  await h.agent().whenIdle();
  assert.equal(executions, 0);
  assert.equal(h.reads.length, 1);
  assert.equal(h.host.adapter.requests.length, 3);
  assert.deepEqual(
    h.host.adapter.requests[2].tools.map((tool) => tool.name),
    ['read_accepted_input'],
  );
  const history = await allHistory(h.host.service, h.current);
  const result = history.filter((event) => event.type === 'tool/result').at(-1);
  assert.equal(result.data.message.isError, true);
  assert.equal(JSON.stringify(result).includes('forbidden-body'), false);
});

test('actual native tool refuses every mismatched source echo, including same number with a different immutable ID', async (t) => {
  const changes = [
    (value) => {
      value.actorId = 'outside';
    },
    (value) => {
      value.spaceId = 'other';
    },
    (value) => {
      value.downstream.nodeId = 'other';
    },
    (value) => {
      value.downstream.taskId = 'other';
    },
    (value) => {
      value.downstream.planId = 'other';
    },
    (value) => {
      value.downstream.revision++;
    },
    (value) => {
      value.source.nodeId = 'other';
    },
    (value) => {
      value.source.taskId = 'other';
    },
    (value) => {
      value.source.planId = 'other';
    },
    (value) => {
      value.source.revision++;
    },
    (value) => {
      value.version.id = 'different-ID-same-version-number';
    },
    (value) => {
      value.version.version++;
    },
  ];
  for (const change of changes) {
    const h = await setup(t, {
      ports(ports) {
        const read = ports.reader.upstreamContent;
        ports.reader.upstreamContent = async (...args) => {
          const result = await read(...args);
          assert.equal(result.ok, true);
          change(result.value);
          return result;
        };
      },
    });
    assert.deepEqual(await h.invoke({ inputRef: h.ref, part: 'text', limit: 1 }), {
      ok: false,
      code: 'input-unavailable',
    });
    await h.host.close();
  }
});

test('actual native finalizer suppresses a source after post-policy authority loss and never falls back to its body', async (t) => {
  const h = await setup(t, {
    compose(ctx, current) {
      ctx.on('tools/post-execute', async (_exec, _result, next) => {
        current.deny();
        return next();
      });
    },
  });
  h.host.adapter.script.push(toolResponse({ inputRef: h.ref, part: 'text', limit: 2 }));
  await h.host.service.send(h.current, message('post-revoke', 'Read selected input'));
  await h.agent().whenIdle();
  h.current.assertCurrent = () => {};
  const events = await allHistory(h.host.service, h.current);
  const result = events.find((event) => event.type === 'tool/result');
  assert.ok(result);
  assert.deepEqual(JSON.parse(result.data.message.content[0].text), {
    ok: false,
    code: 'cancelled',
  });
  assert.equal(
    JSON.stringify(events.filter((event) => event.type === 'tool/result')).includes('😀汉'),
    false,
  );
  assert.equal(h.host.adapter.requests.length, 1);
});

test('actual native tool re-resolves the caller after a held B read and consumes a late rejection after revocation', async (t) => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  let authorized = true;
  const h = await setup(t, {
    ports(ports, input) {
      ports.resolveCurrentCaller = async () => (authorized ? input.caller : {});
      const read = ports.reader.upstreamContent;
      ports.reader.upstreamContent = async (...args) => {
        const result = await read(...args);
        entered.resolve();
        await release.promise;
        return result;
      };
    },
  });
  const calling = h.invoke({ inputRef: h.ref, part: 'text', limit: 2 });
  await entered.promise;
  authorized = false;
  release.resolve();
  assert.deepEqual(await calling, { ok: false, code: 'input-unavailable' });
  assert.equal(h.host.service.open(h.current).binding.inputReadBudget.chargedBytes, 24576);
  await h.host.service.whenInputReadsIdle();

  const late = Promise.withResolvers(),
    started = Promise.withResolvers();
  h.ports.reader.upstreamContent = async () => {
    started.resolve();
    return late.promise;
  };
  authorized = true;
  h.host.adapter.script.push(
    toolResponse({ inputRef: h.ref, part: 'text', limit: 1 }, 'late-read'),
  );
  await h.host.service.send(h.current, message('late-reject', 'Read again'));
  await started.promise;
  h.current.revoke();
  late.reject(Error('private-source-error-do-not-echo'));
  await h.host.service.whenInputReadsIdle();
  await h.host.close();
});

test(
  'actual native logical timeout, total five-second stop, held-I/O close and same-disk reopen preserve slot and budget',
  { timeout: 20000 },
  async (t) => {
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    const h = await setup(t, {
      ports(ports) {
        const read = ports.reader.upstreamContent;
        ports.reader.upstreamContent = async (...args) => {
          const result = await read(...args);
          entered.resolve();
          await release.promise;
          result.value.content.text = 'LATE-OLD-BODY';
          return result;
        };
      },
    });
    t.onTestFinished(() => release.resolve());
    const waiting = h.invoke({ inputRef: h.ref, part: 'text', limit: 1 });
    await entered.promise;
    assert.deepEqual(await waiting, { ok: false, code: 'read-timeout' });
    assert.deepEqual(await h.invoke({ inputRef: h.ref, part: 'text', limit: 1 }), {
      ok: false,
      code: 'input-read-busy',
    });
    assert.equal(h.reads.length, 1);
    const start = performance.now();
    assert.equal((await h.host.service.stop(h.current)).status, 'pending');
    assert.ok(
      performance.now() - start >= 4900 && performance.now() - start < 6500,
      'one total five-second stop wait',
    );
    assert.equal(h.agent().status, 'idle', 'driver idle alone is not I/O drain');
    const binding = structuredClone(h.host.service.open(h.current).binding);
    assert.deepEqual(binding.inputReadBudget, { attempts: 1, chargedBytes: 24576 });
    let closed = false;
    const closing = h.host.close().then(() => {
      closed = true;
    });
    const beforeDomain = await domainBytes(h.root);
    // The second Host only attempts direct runtime.connect: no service.send or
    // metadata mutation is used as a purported business authorization proof.
    const second = await boot(h.root, new ScriptedAdapter([]));
    try {
      assert.equal(closed, false);
      const before = structuredClone(second.service.open(h.current).binding);
      await assert.rejects(second.runtime.connect(before, h.current, false));
      assert.deepEqual(second.service.open(h.current).binding, before);
      assert.deepEqual(before, binding);
      assert.equal(second.adapter.requests.length, 0);
    } finally {
      await second.close();
    }
    assert.deepEqual(
      await domainBytes(h.root),
      beforeDomain,
      'foreign refusal/close cannot rewrite metadata bytes',
    );
    assert.equal(closed, false);
    release.resolve();
    await closing;
    let reopened;
    reopened = await boot(
      h.root,
      new ScriptedAdapter([
        toolResponse({ inputRef: h.ref, part: 'text', limit: 1 }, 'new-read'),
        'New result',
      ]),
      (ctx, next, current) =>
        registerNativeAcceptedInputTool(ctx, next, current, reopened.service, {
          ...h.ports,
          reader: { upstreamContent: (...args) => h.input.service.upstreamContent(...args) },
        }),
    );
    try {
      assert.deepEqual(reopened.service.open(h.current).binding, binding);
      await reopened.service.send(h.current, message('after-reopen', 'Read now'));
      await reopened.ctx.agents.get(binding.nativeSessionId).whenIdle();
      const history = await allHistory(reopened.service, h.current);
      const results = history.filter((event) => event.type === 'tool/result');
      assert.equal(JSON.stringify(results).includes('LATE-OLD-BODY'), false);
      assert.equal(JSON.parse(results.at(-1).data.message.content[0].text).text, '😀');
      const next = reopened.service.open(h.current).binding;
      assert.equal(next.inputReadBudget.attempts, 2);
      assert.ok(next.inputReadBudget.chargedBytes > 24576);
      assert.equal(next.receipts.length, 3);
      assert.equal(next.nativeSessionId, binding.nativeSessionId);
    } finally {
      await reopened.close();
    }
  },
);

test('actual native output cap rejects oversized links and never fetches or pretends to return file bytes', async (t) => {
  const h = await setup(t, {
    ports(ports) {
      const read = ports.reader.upstreamContent;
      ports.reader.upstreamContent = async (...args) => {
        const result = await read(...args);
        result.value.content.links = [`https://example.com/${'x'.repeat(25000)}`];
        result.value.content.files = [{ id: 'unfetched-file-metadata' }];
        return result;
      };
    },
  });
  assert.deepEqual(await h.invoke({ inputRef: h.ref, part: 'links' }), {
    ok: false,
    code: 'output-too-large',
  });
  const events = await allHistory(h.host.service, h.current);
  assert.equal(JSON.stringify(events).includes('unfetched-file-metadata'), false);
  assert.equal(h.reads.length, 1);
  assert.equal(h.host.service.open(h.current).binding.inputReadBudget.chargedBytes, 24576);
});

test(
  'actual native persisted attempt cap survives normal same-disk reopen',
  { timeout: 15000 },
  async (t) => {
    const h = await setup(t);
    for (let i = 0; i < 16; i++)
      assert.equal(
        (await h.invoke({ inputRef: h.ref, part: 'text', offset: i, limit: 1 })).ok,
        true,
      );
    const binding = h.host.service.open(h.current).binding;
    await h.host.close();
    let reopened;
    reopened = await boot(
      h.root,
      new ScriptedAdapter([
        toolResponse({ inputRef: h.ref, part: 'text', limit: 1 }, 'exhausted'),
        'Budget observed',
      ]),
      (ctx, next, current) =>
        registerNativeAcceptedInputTool(ctx, next, current, reopened.service, h.ports),
    );
    try {
      assert.deepEqual(reopened.service.open(h.current).binding, binding);
      await reopened.service.send(h.current, message('budget-after-reopen', 'Read again'));
      await reopened.ctx.agents.get(binding.nativeSessionId).whenIdle();
      const history = await allHistory(reopened.service, h.current);
      assert.deepEqual(
        JSON.parse(
          history.filter((event) => event.type === 'tool/result').at(-1).data.message.content[0]
            .text,
        ),
        { ok: false, code: 'input-read-budget-exceeded' },
      );
      assert.deepEqual(
        reopened.service.open(h.current).binding.inputReadBudget,
        binding.inputReadBudget,
      );
      assert.equal(h.reads.length, 16);
    } finally {
      await reopened.close();
    }
  },
);
