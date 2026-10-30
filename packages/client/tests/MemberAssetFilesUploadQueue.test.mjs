/** Original public member API contracts; no network, durable backend or GUI proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MemberAssetFilesUploadQueue } from '../dist/assets/MemberAssetFilesUploadQueue.js';
import { MemberAssetClientError } from '../dist/assets/api.js';
const deferred = () => Promise.withResolvers();
const file = (name = 'guide.txt') => new File(['Real file bytes'], name, { type: 'text/plain' });
const phase = (h) => h.queue.getSnapshot().rows[0].phase;
function harness(t, hooks = {}) {
  const records = new Map(),
    calls = { command: [], upload: [], read: [] },
    events = { current: true, changed: 0 };
  const api = {
    async command(input, signal) {
      calls.command.push(structuredClone(input));
      let row = records.get(input.assetId);
      if (input.operation === 'create-draft') {
        row ??= { version: 1, name: input.definition.name };
        records.set(input.assetId, row);
      } else {
        if (!row?.upload) throw new MemberAssetClientError('asset-not-found');
        if (input.expectedVersion !== row.version && !row.cancel)
          throw new MemberAssetClientError('asset-conflict');
        if (!row.cancel) {
          row.cancel = structuredClone(input);
          row.version++;
        }
      }
      await hooks.command?.(input, row, signal);
      return {
        disposition: 'applied',
        actorId: 'ann',
        resultVersion: input.operation === 'create-draft' ? 1 : row.version,
        asset: { assetId: input.assetId, spaceId: 'north', version: row.version },
      };
    },
    async upload(input, source, signal) {
      calls.upload.push({ input: structuredClone(input), source });
      const row = records.get(input.assetId);
      if (!row.upload) {
        assert.equal(input.expectedVersion, row.version);
        row.upload = structuredClone(input);
        row.version++;
      }
      await hooks.upload?.(input, row, signal);
      if (!row.cancel) {
        row.file = input.declare;
        row.version = input.expectedVersion + 2;
      }
      return {
        spaceId: input.spaceId,
        assetId: input.assetId,
        idempotencyKey: input.idempotencyKey,
        assetVersion: row.version,
        file: input.declare,
      };
    },
    async read(input, signal) {
      calls.read.push(structuredClone(input));
      const row = records.get(input.assetId);
      await hooks.read?.(input, row, signal);
      return {
        actorId: 'ann',
        asset: { assetId: input.assetId, spaceId: input.spaceId, version: row.version },
        ...(row.file ? { file: structuredClone(row.file) } : {}),
      };
    },
  };
  const queue = new MemberAssetFilesUploadQueue({
    api,
    spaceId: 'north',
    isCurrent: () => events.current,
    onChanged: () => events.changed++,
  });
  t.after(() => queue.dispose());
  return { api, queue, records, calls, events };
}
test('batch queue: atomic count/byte/path bounds and pre-upload removal preserve other rows', (t) => {
  const h = harness(t);
  h.queue.add([file('one.txt'), file('two.txt')]);
  h.queue.remove(h.queue.getSnapshot().rows[0].id);
  assert.deepEqual(
    h.queue.getSnapshot().rows.map((row) => row.name),
    ['two.txt'],
  );
  const before = h.queue.getSnapshot();
  assert.throws(() => h.queue.add(Array.from({ length: 50 }, () => file())), /50/);
  const huge = file();
  Object.defineProperty(huge, 'size', { value: 20 * 1024 * 1024 });
  assert.throws(() => h.queue.add([huge]), /总量/);
  const folder = file();
  Object.defineProperty(folder, 'webkitRelativePath', { value: 'folder/guide.txt' });
  assert.throws(() => h.queue.add([folder]), /普通文件/);
  assert.equal(h.queue.getSnapshot(), before);
  assert.equal(h.calls.command.length, 0);
});
test('batch queue: concurrency1, exact actual bytes/hash and completed item count; no automatic publish', async (t) => {
  const held = deferred(),
    entered = deferred();
  const h = harness(t, {
    upload: async () => {
      if (h.calls.upload.length === 1) {
        entered.resolve();
        await held.promise;
      }
    },
  });
  const source = file('one.txt');
  h.queue.add([source, file('two.txt')]);
  const run = h.queue.start();
  await entered.promise;
  assert.equal(h.calls.command.length, 1);
  assert.equal(h.calls.upload.length, 1);
  assert.equal(h.queue.getSnapshot().completed, 0);
  assert.equal(phase(h), 'uploading');
  held.resolve();
  await run;
  assert.equal(h.queue.getSnapshot().completed, 2);
  assert.equal(h.queue.getSnapshot().dirty, false);
  assert.equal(h.calls.upload[0].source, source);
  assert.equal(
    h.calls.upload[0].input.declare.sha256,
    createHash('sha256').update('Real file bytes').digest('hex'),
  );
  assert.deepEqual(
    h.calls.command.map((input) => input.operation),
    ['create-draft', 'create-draft'],
  );
});
test('batch queue: lost create ACK pauses later files and retries original asset/key/body, not a second asset', async (t) => {
  let lose = true;
  const h = harness(t, {
    command(input) {
      if (input.operation === 'create-draft' && lose) {
        lose = false;
        throw new MemberAssetClientError('asset-unavailable', 'unknown');
      }
    },
  });
  h.queue.add([file('one.txt'), file('two.txt')]);
  await h.queue.start();
  assert.equal(phase(h), 'unknown');
  assert.equal(h.calls.upload.length, 0);
  assert.equal(h.records.size, 1);
  await h.queue.retry(h.queue.getSnapshot().rows[0].id);
  assert.deepEqual(h.calls.command[0], h.calls.command[1]);
  assert.equal(h.records.size, 1);
  assert.equal(h.queue.getSnapshot().completed, 1);
  assert.equal(h.queue.getSnapshot().rows[1].phase, 'queued');
});
test('batch queue: lost upload ACK retries the identical reserve intent and original File, without recreating the draft', async (t) => {
  let lose = true;
  const h = harness(t, {
    upload(input, row) {
      if (lose) {
        lose = false;
        row.file = input.declare;
        row.version++;
        throw new MemberAssetClientError('asset-unavailable', 'unknown');
      }
    },
  });
  h.queue.add([file()]);
  await h.queue.start();
  assert.equal(phase(h), 'unknown');
  await h.queue.retry(h.queue.getSnapshot().rows[0].id);
  assert.equal(h.calls.command.length, 1);
  assert.deepEqual(h.calls.upload[0].input, h.calls.upload[1].input);
  assert.equal(h.calls.upload[0].source, h.calls.upload[1].source);
  assert.equal(phase(h), 'complete');
});
test('batch queue: acknowledged upload followed by failed detail read is unresolved and reuses original upload on explicit retry', async (t) => {
  let lose = true;
  const h = harness(t, {
    read() {
      if (lose) {
        lose = false;
        throw new MemberAssetClientError('asset-not-found');
      }
    },
  });
  h.queue.add([file()]);
  await h.queue.start();
  assert.equal(phase(h), 'unknown');
  await h.queue.retry(h.queue.getSnapshot().rows[0].id);
  assert.equal(phase(h), 'complete');
  assert.deepEqual(h.calls.upload[0].input, h.calls.upload[1].input);
});
test('batch queue: cancel uses current reserved version/original upload key; a lost cancel ACK stays unresolved and retries exact body', async (t) => {
  const held = deferred(),
    entered = deferred();
  let lose = true;
  const h = harness(t, {
    upload: async () => {
      entered.resolve();
      await held.promise;
    },
    command(input) {
      if (input.operation === 'cancel-upload' && lose) {
        lose = false;
        throw new MemberAssetClientError('asset-unavailable', 'unknown');
      }
    },
  });
  h.queue.add([file(), file('later.txt')]);
  const run = h.queue.start();
  await entered.promise;
  const id = h.queue.getSnapshot().rows[0].id;
  await h.queue.cancel(id);
  assert.equal(phase(h), 'cancel-unknown');
  assert.equal(h.queue.getSnapshot().completed, 0);
  held.resolve();
  await run;
  await h.queue.retry(id);
  const cancels = h.calls.command.filter((input) => input.operation === 'cancel-upload');
  assert.equal(cancels[0].expectedVersion, 2);
  assert.equal(cancels[0].uploadKey, h.calls.upload[0].input.idempotencyKey);
  assert.deepEqual(cancels[0], cancels[1]);
  assert.equal(phase(h), 'cancelled');
  assert.equal(h.queue.getSnapshot().rows[1].phase, 'queued');
  assert.equal(h.calls.upload.length, 1);
});
test('batch queue: cancel ACK does not undo an upload that already committed; detail truth says completed draft', async (t) => {
  const entered = deferred(),
    held = deferred();
  const h = harness(t, {
    upload: async (input, row) => {
      row.file = input.declare;
      row.version = 3;
      entered.resolve();
      await held.promise;
    },
  });
  h.queue.add([file()]);
  const run = h.queue.start();
  await entered.promise;
  await h.queue.cancel(h.queue.getSnapshot().rows[0].id);
  assert.equal(phase(h), 'complete');
  assert.match(h.queue.getSnapshot().rows[0].error, /取消前已上传/);
  held.resolve();
  await run;
  assert.equal(phase(h), 'complete');
});
test('batch queue: cancellation before a reserve exists stays pending, never falsely cancelled; definitive conflict refresh retains cancel identity', async (t) => {
  let fail = true;
  const h = harness(t, {
    upload: async (_input, row) => {
      if (fail) {
        delete row.upload;
        row.version = 1;
        throw new MemberAssetClientError('asset-unavailable', 'unknown');
      }
    },
  });
  h.queue.add([file()]);
  await h.queue.start();
  const id = h.queue.getSnapshot().rows[0].id;
  await h.queue.cancel(id);
  assert.equal(phase(h), 'cancel-unknown');
  const original = h.calls.command.at(-1);
  assert.equal(original.operation, 'cancel-upload');
  fail = false;
  const row = h.records.get(id);
  row.upload = h.calls.upload[0].input;
  row.version = 2;
  await h.queue.retry(id);
  assert.equal(phase(h), 'cancelled');
  const next = h.calls.command.at(-1);
  assert.equal(next.uploadKey, original.uploadKey);
  assert.equal(next.idempotencyKey, original.idempotencyKey);
  assert.equal(next.expectedVersion, 2);
});
test('batch queue: a newer external row mutation cannot be fenced by cancelling the earlier upload', async (t) => {
  const h = harness(t, {
    upload(_input, row) {
      row.version = 4;
      throw new MemberAssetClientError('asset-unavailable', 'unknown');
    },
  });
  h.queue.add([file()]);
  await h.queue.start();
  await h.queue.cancel(h.queue.getSnapshot().rows[0].id);
  assert.equal(phase(h), 'cancel-unknown');
  assert.deepEqual(
    h.calls.command.map((input) => input.operation),
    ['create-draft'],
  );
  assert.equal([...h.records.values()][0].version, 4);
});
test('batch queue: stopping hash never creates a draft; stopping an admitted create never starts upload or the next file', async (t) => {
  const data = deferred(),
    hashing = file();
  hashing.arrayBuffer = () => data.promise;
  const h = harness(t);
  h.queue.add([hashing, file('later.txt')]);
  const run = h.queue.start();
  await h.queue.cancel(h.queue.getSnapshot().rows[0].id);
  data.resolve(new ArrayBuffer(0));
  await run;
  assert.equal(phase(h), 'stopped');
  assert.equal(h.calls.command.length, 0);
  const created = deferred(),
    entered = deferred();
  const g = harness(t, {
    command: async () => {
      entered.resolve();
      await created.promise;
    },
  });
  g.queue.add([file(), file('later.txt')]);
  const pending = g.queue.start();
  await entered.promise;
  await g.queue.cancel(g.queue.getSnapshot().rows[0].id);
  assert.equal(phase(g), 'unknown');
  created.resolve();
  await pending;
  assert.equal(phase(g), 'stopped');
  assert.equal(g.calls.upload.length, 0);
  assert.equal(g.calls.command.length, 1);
});
test('batch queue: lost create ACK after stop is reconciled with the same original create, then remains stopped', async (t) => {
  const h = harness(t, {
    command: async () => {
      if (h.calls.command.length === 1)
        throw new MemberAssetClientError('asset-unavailable', 'unknown');
    },
  });
  h.queue.add([file()]);
  await h.queue.start();
  const id = h.queue.getSnapshot().rows[0].id;
  await h.queue.cancel(id);
  await h.queue.retry(id);
  assert.deepEqual(h.calls.command[0], h.calls.command[1]);
  assert.equal(phase(h), 'stopped');
  assert.equal(h.calls.upload.length, 0);
});
test('batch queue: retired lifetime or dispose aborts the original signal, suppresses late UI/callbacks and never starts a later file', async (t) => {
  for (const dispose of [true, false]) {
    const entered = deferred(),
      held = deferred();
    let active;
    const h = harness(t, {
      command: async (_input, _row, signal) => {
        active = signal;
        entered.resolve();
        await held.promise;
      },
    });
    h.queue.add([file(), file('later.txt')]);
    const pending = h.queue.start();
    await entered.promise;
    const before = h.queue.getSnapshot(),
      changed = h.events.changed;
    if (dispose) h.queue.dispose();
    else h.events.current = false;
    held.resolve();
    await pending;
    assert.equal(active.aborted, true);
    assert.equal(h.queue.getSnapshot(), before);
    assert.equal(h.events.changed, changed);
    assert.equal(h.calls.command.length, 1);
    assert.equal(h.calls.upload.length, 0);
  }
});
