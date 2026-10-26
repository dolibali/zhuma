/** Real SDK JSON ledger; these are provenance/schema contracts, not byte/Run authorization. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as JsonStorage from '@deepseek-ai/dsh-storage-json';
import * as Domain from '@deepseek-ai/dsh-storage-domain';
import { openArtifactFileStore, artifactFilesDomainSpec } from '../dist/artifact-files.js';

const source = {
  scope: {
    actorId: 'member',
    spaceId: 'space',
    taskId: 'task',
    planId: 'plan',
    revision: 1,
    nodeId: 'node',
    runId: 'run',
    generation: 1,
    segmentId: 'segment',
  },
  nativeSessionId: 'native-session',
  nativeAgentId: 'native-agent',
  configurationId: 'configuration',
  expertVersionId: 'expert-v1',
  toolVersion: 'zhuma-native-output-file@1',
  callId: 'native-call',
};
const record = (extra = {}) => ({
  uploadId: 'published',
  attachmentId: `sha256:${'a'.repeat(64)}`,
  name: 'result.bin',
  mediaType: 'application/octet-stream',
  byteSize: 11,
  sha256: 'a'.repeat(64),
  spaceId: 'space',
  taskId: 'task',
  planId: 'plan',
  revision: 1,
  nodeId: 'node',
  uploadedBy: 'member',
  idempotencyKey: 'publication-operation',
  state: 'completed',
  uploadedAt: '2026-10-26T00:00:00Z',
  producer: {
    kind: 'native-run-output',
    version: 1,
    source: structuredClone(source),
    selectorFingerprint: 'b'.repeat(64),
  },
  ...extra,
});
async function open(root) {
  const ctx = new Context();
  for (const [plugin, config] of [
    [Storage],
    [JsonStorage, { root }],
    [Domain, { backend: 'json' }],
  ])
    await ctx.plugin(plugin, config);
  const files = await openArtifactFileStore(ctx);
  return {
    files,
    close: async () => {
      await files.close();
      await ctx.fiber.dispose();
    },
  };
}
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-output-ledger-'));
  let host = await open(root);
  t.after(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    get files() {
      return host.files;
    },
    reopen: async () => {
      await host.close();
      host = await open(root);
    },
  };
}

test('output ledger contract: old human JSON opens unchanged; native provenance survives a cold reopen in the same v1 table', async (t) => {
  const h = await setup(t);
  const old = record({ uploadId: 'human', idempotencyKey: 'human-operation' });
  delete old.producer;
  await h.files.put(old);
  const path = join(h.root, 'zhuma_files.json'),
    original = await readFile(path);
  await h.reopen();
  assert.deepEqual(await readFile(path), original);
  assert.deepEqual(h.files.get('human'), old);
  await h.files.putNativePublication(record());
  await h.reopen();
  assert.equal(artifactFilesDomainSpec.version, 1);
  assert.deepEqual(h.files.findNativePublication(source), record());
  assert.deepEqual(h.files.get('human'), old);
  assert.equal(h.files.countInSpace('space'), 2);
  assert.equal(h.files.bytesForNode('task', 'plan', 1, 'node'), 22);
  assert.equal(h.files.countNativePublications(source.scope), 1);
});

test('output ledger contract: the prior strict record shape rejects native provenance instead of silently dropping it', async () => {
  const legacyStrictParser = artifactFilesDomainSpec.tables.files.valueSchema.omit({
    producer: true,
  });
  const old = record();
  delete old.producer;
  assert.equal(legacyStrictParser.safeParse(old).success, true);
  assert.equal(legacyStrictParser.safeParse(record()).success, false);
});

test('output ledger contract: ordinary upload writes cannot mint native provenance and old inputs are never native publications', async (t) => {
  const h = await setup(t);
  await assert.rejects(h.files.put(record()), { code: 'validation' });
  const input = record();
  delete input.producer;
  await h.files.put(input);
  assert.equal(h.files.findNativePublication(source), undefined);
  await assert.rejects(h.files.putNativePublication(record({ uploadId: 'second' })), {
    code: 'conflict',
  });
});

test('output ledger contract: bad scope/controller/version/attachment tuples cannot poison the authoritative domain', async (t) => {
  const h = await setup(t);
  for (const bad of [
    record({ uploadedBy: 'expert' }),
    record({ spaceId: 'foreign' }),
    record({ nodeId: 'foreign' }),
    record({ attachmentId: 'sha256:forged' }),
    record({ producer: { ...record().producer, version: 2 } }),
  ])
    await assert.rejects(h.files.putNativePublication(bad));
  assert.equal(h.files.countInSpace('space'), 0);
  await h.files.putNativePublication(record());
  await assert.rejects(h.files.putNativePublication(record({ uploadId: 'duplicate' })), {
    code: 'conflict',
  });
  await h.reopen();
  assert.equal(h.files.countInSpace('space'), 1);
});
