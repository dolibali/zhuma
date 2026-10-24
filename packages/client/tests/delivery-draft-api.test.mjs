import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionApi, readSavedDeliveryDraft } from '../dist/execution/ExecutionApi.js';
import { revisionQuery } from './revision-fixture.mjs';
import { savedDraft } from './delivery-draft-fixture.mjs';

test('draft DTO: a valid tombstone version is preserved; absence or failures never become version zero', async () => {
  assert.deepEqual(readSavedDeliveryDraft({ version: 8, text: '', links: [], files: [] }), {
    version: 8,
    text: '',
    links: [],
    files: [],
  });
  assert.deepEqual(readSavedDeliveryDraft({ version: 0, text: '', links: [], files: [] }), {
    version: 0,
    text: '',
    links: [],
    files: [],
  });
  const api = createExecutionApi({
    async call() {
      return {
        ok: false,
        error: { code: 'not-deliverable', message: '节点不可交付。', details: {} },
      };
    },
  });
  await assert.rejects(
    api.readDeliveryDraft(revisionQuery),
    (error) => error.code === 'not-deliverable',
  );
});

test('draft API: exact four-field read and versioned write share the draft endpoint, preserve all files and links', async () => {
  const calls = [],
    source = savedDraft();
  const api = createExecutionApi(
    {
      async call(channel, endpoint, payload, signal) {
        calls.push({ channel, endpoint, payload, signal });
        return { ok: true, value: source };
      },
    },
    'bound-space',
  );
  const abort = new AbortController();
  const read = await api.readDeliveryDraft(
    { ...revisionQuery, actorId: 'ignored', spaceId: 'ignored' },
    abort.signal,
  );
  assert.deepEqual(calls[0], {
    channel: '/api',
    endpoint: 'zhuma-exec/draft',
    payload: revisionQuery,
    signal: abort.signal,
  });
  source.files[0].extra = 'not-public';
  const write = {
    ...revisionQuery,
    expectedVersion: 6,
    idempotencyKey: 'draft-save',
    text: source.text,
    links: source.links,
    files: read.files,
  };
  const response = await api.saveDeliveryDraft({ ...write, spaceId: 'ignored' }, abort.signal);
  assert.deepEqual(calls[1].payload, write);
  assert.equal(calls[1].endpoint, 'zhuma-exec/draft');
  assert.equal(calls[1].signal, abort.signal);
  assert.equal('extra' in response.files[0], false);
  source.links.push('later');
  source.files[0].checksum = 'changed-after-read';
  assert.equal(read.links.length, 2);
  assert.equal(read.files[0].checksum, 'fixture-checksum');
});

test('draft API: a save receipt must be the next draft version, independently of Node.version', async () => {
  const api = createExecutionApi({
    async call() {
      return { ok: true, value: savedDraft() };
    },
  });
  await assert.rejects(
    api.saveDeliveryDraft({
      ...revisionQuery,
      expectedVersion: 0,
      idempotencyKey: 'first',
      text: 'new',
    }),
    (error) => error.code === 'validation',
  );
  assert.equal(
    (
      await api.saveDeliveryDraft({
        ...revisionQuery,
        expectedVersion: 6,
        idempotencyKey: 'next',
        text: 'new',
      })
    ).version,
    7,
  );
});

for (const [name, alter] of [
  [
    'missing version',
    (v) => {
      delete v.version;
    },
  ],
  [
    'negative version',
    (v) => {
      v.version = -1;
    },
  ],
  [
    'fractional version',
    (v) => {
      v.version = 1.5;
    },
  ],
  [
    'missing text',
    (v) => {
      delete v.text;
    },
  ],
  [
    'missing links',
    (v) => {
      delete v.links;
    },
  ],
  [
    'missing files',
    (v) => {
      delete v.files;
    },
  ],
  [
    'empty link',
    (v) => {
      v.links = [''];
    },
  ],
  [
    'incomplete file metadata',
    (v) => {
      delete v.files[0].checksum;
    },
  ],
  [
    'missing file policy',
    (v) => {
      delete v.files[0].accessPolicyId;
    },
  ],
  [
    'negative bytes',
    (v) => {
      v.files[0].byteSize = -1;
    },
  ],
  [
    'completed upload flag',
    (v) => {
      v.files[0].uploadComplete = true;
    },
  ],
  [
    'missing upload flag',
    (v) => {
      delete v.files[0].uploadComplete;
    },
  ],
])
  test(`draft DTO: reject ${name} without a fabricated empty/saved result`, () => {
    const value = savedDraft();
    alter(value);
    assert.throws(
      () => readSavedDeliveryDraft(value),
      (error) => error.code === 'validation',
    );
  });

for (const code of [
  'conflict',
  'idempotency-mismatch',
  'not-found',
  'not-assignee',
  'files-not-accepted',
])
  test(`draft API: typed ${code} preserves details and is not retried or normalized to version zero`, async () => {
    let calls = 0;
    const api = createExecutionApi({
      async call() {
        calls++;
        return {
          ok: false,
          error: { code, message: '请求未被接受。', details: { currentVersion: 9 } },
        };
      },
    });
    await assert.rejects(
      api.saveDeliveryDraft({
        ...revisionQuery,
        expectedVersion: 7,
        idempotencyKey: 'retry',
        text: 'draft',
      }),
      (error) => error.code === code && error.details.currentVersion === 9,
    );
    assert.equal(calls, 1);
  });
