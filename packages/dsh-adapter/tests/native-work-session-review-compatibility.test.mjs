/** Actual old parser/Service/DSH StorageDomain read code; no old application binary,
 * native review execution, authenticated member session or model-quality claim. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as JsonStorage from '@deepseek-ai/dsh-storage-json';
import * as Domain from '@deepseek-ai/dsh-storage-domain';
import {
  NATIVE_REVIEW_WRITER_MARKER,
  nativeReviewGlobalSchema,
  nativeReviewAwareRecordSchema,
  nativeReviewSessionKey,
} from '../dist/native-work-session-review-contract.js';
import { readNativeRecord, nativeWorkSessionKey } from '../dist/native-work-session-record.js';
import { nativeWorkSessionDomainSpec } from '../dist/native-work-session-storage.js';
import { NativeWorkSessionService } from '../dist/native-work-session.js';
import { scope, context, binding } from './native-work-session-review-fixture.mjs';

const reviewRecord = () => ({
  schemaVersion: 3,
  role: 'review',
  context: context(),
  binding: binding(),
});

test('review compatibility: original strict parser rejects v3 before an old Service can write/connect/send', async () => {
  const record = reviewRecord();
  assert.throws(() => readNativeRecord(record), { code: 'binding-state-invalid' });
  const calls = [];
  const storage = {
    read: () => structuredClone(record),
    write: async () => {
      calls.push('write');
    },
  };
  const runtime = new Proxy(
    {},
    {
      get: (_, name) => () => {
        calls.push(name);
        throw Error('unexpected old runtime call');
      },
    },
  );
  const service = new NativeWorkSessionService(storage, runtime);
  const grant = { scope, signal: new AbortController().signal, assertCurrent() {} };
  await assert.rejects(
    service.send(grant, {
      requestId: 'old-send',
      text: 'must not start author',
      mode: 'followup',
      selection: binding().selection,
    }),
    { code: 'binding-state-invalid' },
  );
  assert.deepEqual(calls, []);
});

async function storageContext(root) {
  const ctx = new Context();
  try {
    await ctx.plugin(Storage);
    await ctx.plugin(JsonStorage, { root });
    await ctx.plugin(Domain, { backend: 'json' });
    return ctx;
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}
async function files(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else {
      const info = await stat(path, { bigint: true });
      result.push({
        path,
        size: String(info.size),
        mtime: String(info.mtimeNs),
        hash: createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      });
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

for (const withReviewRecord of [false, true])
  test(`review compatibility: real original DSH domain refuses ${withReviewRecord ? 'v3 record plus marker' : 'marker-only crash prefix'} without changing persisted bytes/mtime`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'zhuma-review-legacy-'));
    try {
      const writer = await storageContext(root);
      try {
        const nextSpec = {
          ...nativeWorkSessionDomainSpec,
          global: { schema: nativeReviewGlobalSchema, initial: { schemaVersion: 1 } },
          tables: { bindings: { valueSchema: nativeReviewAwareRecordSchema } },
        };
        const domain = await writer.storageDomain.open(nextSpec);
        await domain.table('bindings').put(nativeWorkSessionKey(scope), binding());
        await domain.global.set(NATIVE_REVIEW_WRITER_MARKER);
        if (withReviewRecord)
          await domain.table('bindings').put(nativeReviewSessionKey(context()), reviewRecord());
        await domain.close();
      } finally {
        await writer.fiber.dispose();
      }
      const before = await files(root);
      assert.ok(before.length > 0);
      const reader = await storageContext(root);
      try {
        await assert.rejects(reader.storageDomain.open(nativeWorkSessionDomainSpec), {
          code: 'invalid-record',
        });
      } finally {
        await reader.fiber.dispose();
      }
      assert.deepEqual(await files(root), before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
