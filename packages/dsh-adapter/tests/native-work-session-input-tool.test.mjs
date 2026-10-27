/** Pure port/metadata contracts, not native execution or member authorization. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeWorkSessionService } from '../dist/native-work-session.js';
import { nativeWorkSessionBindingSchema } from '../dist/native-work-session-storage.js';
import {
  acceptedInputRef,
  describeAcceptedInputTool,
  registerNativeAcceptedInputTool,
} from '../dist/native-work-session-input-tool.js';
import { grant, message, scope, selection } from './native-work-session-fixture.mjs';

function harness() {
  let record;
  const storage = {
    read: () => record,
    write: async (_key, value) => {
      record = structuredClone(value);
    },
  };
  const runtime = {
    connect: async () => {},
    isConnected: () => true,
    status: () => 'idle',
    send: () => {},
    flush: async () => {},
    stop: async () => 'stopped',
  };
  return {
    service: new NativeWorkSessionService(storage, runtime),
    storage,
    runtime,
    value: () => record,
  };
}
const visible = {
  access: 'visible',
  blocking: false,
  sourceNodeId: 'upstream',
  artifactVersionId: 'artifact:1',
  version: 1,
  name: 'First version',
};

test('contract: accepted-input metadata is pure JSON, immutable and matches the registered definition', async () => {
  const first = describeAcceptedInputTool();
  const second = describeAcceptedInputTool();
  assert.deepEqual(Object.keys(first).sort(), [
    'description',
    'name',
    'outputSchema',
    'parameters',
    'sourceVersion',
  ]);
  assert.equal(first.name, 'read_accepted_input');
  assert.equal(first.sourceVersion, '1');
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
  assert.notEqual(first.parameters, second.parameters);
  assert.notEqual(first.outputSchema, second.outputSchema);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.parameters.properties), true);
  assert.equal(Object.isFrozen(first.outputSchema.oneOf), true);
  assert.equal(Reflect.set(first.parameters.properties.inputRef, 'type', 'number'), false);
  const edited = structuredClone(first);
  edited.parameters.properties.inputRef.type = 'number';
  const h = harness(),
    current = grant();
  await h.service.send(current, message('metadata-only', 'fixture'));
  let registered;
  const ports = {
    catalog: { scope, inputs: [{ input: visible, required: false }] },
    resolveCurrentCaller: () => assert.fail('metadata must not resolve a caller'),
    reader: { upstreamContent: () => assert.fail('metadata must not read content') },
  };
  registerNativeAcceptedInputTool(
    {
      tools: {
        register: (definition) => {
          registered = definition;
        },
      },
      effect: () => {},
    },
    h.service.open(current).binding,
    current,
    h.service,
    ports,
  );
  assert.deepEqual(
    {
      name: registered.name,
      description: registered.description,
      parameters: registered.parameters,
      outputSchema: registered.output.schema,
      sourceVersion: first.sourceVersion,
    },
    second,
  );
  assert.equal(describeAcceptedInputTool().parameters.properties.inputRef.type, 'string');
});

test('contract: opaque handles pin full Run scope and exact version ID, not its display number', () => {
  const ref = acceptedInputRef(scope, visible);
  assert.match(ref, /^input_[a-f0-9]{64}$/);
  assert.equal(acceptedInputRef(structuredClone(scope), { ...visible, name: 'Renamed' }), ref);
  for (const field of ['actorId', 'spaceId', 'taskId', 'planId', 'nodeId', 'runId', 'segmentId'])
    assert.notEqual(acceptedInputRef({ ...scope, [field]: 'other' }, visible), ref);
  for (const field of ['revision', 'generation'])
    assert.notEqual(acceptedInputRef({ ...scope, [field]: 2 }, visible), ref);
  assert.notEqual(
    acceptedInputRef(scope, { ...visible, artifactVersionId: 'different-ID-same-number' }),
    ref,
  );
});

test('contract: required pending/hidden, unknown requiredness, missing ports and wrong catalog scope fail before registration', () => {
  const h = harness(),
    current = grant();
  const binding = { scope, selection };
  const base = {
    catalog: { scope, inputs: [] },
    resolveCurrentCaller: async () => ({}),
    reader: { upstreamContent: async () => ({ ok: false }) },
  };
  const untouched = { tools: { register: () => assert.fail('must not register') } };
  for (const input of [
    {
      access: 'pending',
      pending: 'none',
      blocking: false,
      sourceNodeId: 'upstream',
      message: 'Not accepted',
    },
    { access: 'hidden', blocking: true, count: 2, message: 'Unavailable sources' },
  ])
    assert.throws(
      () =>
        registerNativeAcceptedInputTool(untouched, binding, current, h.service, {
          ...base,
          catalog: { scope, inputs: [{ input, required: true }] },
        }),
      /input-required-unavailable/,
    );
  assert.throws(
    () =>
      registerNativeAcceptedInputTool(untouched, binding, current, h.service, {
        ...base,
        catalog: { scope, inputs: [{ input: visible }] },
      }),
    /input-context-unavailable/,
  );
  assert.throws(
    () => registerNativeAcceptedInputTool(untouched, binding, current, h.service, undefined),
    /input-context-unavailable/,
  );
  assert.throws(
    () =>
      registerNativeAcceptedInputTool(untouched, binding, current, h.service, {
        ...base,
        resolveCurrentCaller: undefined,
      }),
    /input-context-unavailable/,
  );
  assert.throws(
    () =>
      registerNativeAcceptedInputTool(untouched, binding, current, h.service, {
        ...base,
        catalog: { scope: { ...scope, runId: 'other' }, inputs: [] },
      }),
    /input-context-unavailable/,
  );
  const result = registerNativeAcceptedInputTool(untouched, binding, current, h.service, {
    ...base,
    catalog: {
      scope,
      inputs: [
        {
          input: { access: 'hidden', blocking: true, count: 2, message: 'Unavailable sources' },
          required: false,
        },
      ],
    },
  });
  assert.deepEqual(result.toolAllowlist, []);
  assert.match(result.context, /hidden/);
});

test('contract: concurrent reservations use the receipt queue and reject busy without metadata writes', async () => {
  const h = harness(),
    current = grant();
  await h.service.send(current, message('one', 'first'));
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, () => h.service.reserveInputRead(current)),
  );
  const granted = results.filter((r) => r.status === 'fulfilled');
  assert.equal(granted.length, 1);
  assert.equal(
    results.filter((r) => r.status === 'rejected' && r.reason.code === 'input-read-busy').length,
    19,
  );
  assert.equal(
    results.filter((r) => r.status === 'rejected' && r.reason.code === 'input-read-budget-exceeded')
      .length,
    0,
  );
  assert.deepEqual(h.value().inputReadBudget, { attempts: 1, chargedBytes: 24576 });
  await h.service.finishInputRead(current, granted[0].value);
  await h.service.whenInputReadsIdle();
  assert.deepEqual(h.value().inputReadBudget, { attempts: 1, chargedBytes: 24576 });
  assert.equal(h.value().receipts.length, 1);
});

test('contract: settlement rereads latest binding so concurrent sends do not erase receipts or counters', async () => {
  const h = harness(),
    current = grant();
  await h.service.send(current, message('one', 'first'));
  const ticket = await h.service.reserveInputRead(current);
  await h.service.send(current, message('two', 'second'));
  await h.service.finishInputRead(current, ticket, 123);
  assert.deepEqual(
    h.value().receipts.map((r) => r.requestId),
    ['one', 'two'],
  );
  assert.deepEqual(h.value().inputReadBudget, { attempts: 1, chargedBytes: 123 });
  const reopened = new NativeWorkSessionService(h.storage, h.runtime);
  const again = await reopened.reserveInputRead(current);
  await reopened.finishInputRead(current, again, 200);
  assert.deepEqual(h.value().inputReadBudget, { attempts: 2, chargedBytes: 323 });
});

test('contract: stale grant settlement releases the drain while retaining its full charge', async () => {
  const h = harness(),
    current = grant();
  await h.service.send(current, message('one', 'first'));
  const ticket = await h.service.reserveInputRead(current);
  current.deny();
  await assert.rejects(h.service.finishInputRead(current, ticket, 1), /currentness-rejected/);
  await h.service.whenInputReadsIdle();
  assert.deepEqual(h.value().inputReadBudget, { attempts: 1, chargedBytes: 24576 });
});

test('contract: stop fences a reservation paused at persistence, without allowing source I/O', async () => {
  const h = harness(),
    current = grant();
  await h.service.send(current, message('one', 'first'));
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const write = h.storage.write;
  h.storage.write = async (key, value) => {
    entered.resolve();
    await release.promise;
    await write(key, value);
  };
  const reserving = h.service.reserveInputRead(current);
  await entered.promise;
  const stopping = h.service.stop(current);
  release.resolve();
  await assert.rejects(reserving, { code: 'cancelled' });
  assert.equal((await stopping).status, 'stopped');
  await h.service.whenInputReadsIdle();
  assert.deepEqual(h.value().inputReadBudget, { attempts: 1, chargedBytes: 24576 });
});

test('contract: seal blocks new reservations and waits until the existing source actually settles', async () => {
  const h = harness(),
    current = grant();
  await h.service.send(current, message('one', 'first'));
  const ticket = await h.service.reserveInputRead(current);
  let drained = false;
  const closing = h.service.sealInputReads().then(() => {
    drained = true;
  });
  await assert.rejects(h.service.reserveInputRead(current), { code: 'unavailable' });
  assert.equal(drained, false);
  await h.service.finishInputRead(current, ticket);
  await closing;
  assert.equal(drained, true);
});

test('contract: a second runtime cannot race the first reservation persistence or modify its metadata', async () => {
  const h = harness(),
    current = grant();
  await h.service.send(current, message('one', 'first'));
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const write = h.storage.write;
  let writes = 0;
  h.storage.write = async (key, value) => {
    writes++;
    entered.resolve();
    await release.promise;
    await write(key, value);
  };
  const first = h.service.reserveInputRead(current);
  await entered.promise;
  const before = structuredClone(h.value());
  const foreign = new NativeWorkSessionService(h.storage, { ...h.runtime });
  await assert.rejects(foreign.reserveInputRead(current), { code: 'input-read-busy' });
  assert.equal(writes, 1);
  assert.deepEqual(h.value(), before);
  release.resolve();
  await h.service.finishInputRead(current, await first);
  const after = await foreign.reserveInputRead(current);
  await foreign.finishInputRead(current, after, 10);
  assert.deepEqual(h.value().inputReadBudget, { attempts: 2, chargedBytes: 24586 });
});

test('contract: old v1 metadata remains valid; out-of-budget counters are rejected', async () => {
  const h = harness(),
    current = grant();
  await h.service.send(current, message('one', 'first'));
  assert.equal(nativeWorkSessionBindingSchema.safeParse(h.value()).success, true);
  for (const inputReadBudget of [
    { attempts: 17, chargedBytes: 0 },
    { attempts: 0, chargedBytes: 65537 },
    { attempts: -1, chargedBytes: 0 },
  ])
    assert.equal(
      nativeWorkSessionBindingSchema.safeParse({ ...h.value(), inputReadBudget }).success,
      false,
    );
});

test('contract: unknown reads reserve the remaining byte budget conservatively and exhaustion writes nothing', async () => {
  const h = harness(),
    current = grant();
  await h.service.send(current, message('one', 'first'));
  for (const reserved of [24576, 24576, 16384]) {
    const ticket = await h.service.reserveInputRead(current);
    assert.equal(ticket.maximumBytes, reserved);
    await h.service.finishInputRead(current, ticket);
  }
  const before = structuredClone(h.value());
  assert.deepEqual(before.inputReadBudget, { attempts: 3, chargedBytes: 65536 });
  await assert.rejects(h.service.reserveInputRead(current), { code: 'input-read-budget-exceeded' });
  assert.deepEqual(h.value(), before);
});

test('contract: ambiguous reservation persistence retains its charge and releases the no-I/O slot', async () => {
  const h = harness(),
    current = grant();
  await h.service.send(current, message('one', 'first'));
  const write = h.storage.write;
  h.storage.write = async (key, value) => {
    await write(key, value);
    throw Error('ambiguous-write');
  };
  await assert.rejects(h.service.reserveInputRead(current), /ambiguous-write/);
  await h.service.whenInputReadsIdle();
  h.storage.write = write;
  const foreign = new NativeWorkSessionService(h.storage, { ...h.runtime });
  const ticket = await foreign.reserveInputRead(current);
  await foreign.finishInputRead(current, ticket, 10);
  assert.deepEqual(h.value().inputReadBudget, { attempts: 2, chargedBytes: 24586 });
});
