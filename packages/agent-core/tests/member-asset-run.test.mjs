import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import {
  MemberAssetFileSnapshotSchema,
  MemberAssetLegacySourceValueSchema,
  memberAssetFileSnapshotDigestInput,
  canonicalPayload,
  remoteTeamAssetFileReadRequestSchema,
  remoteDeviceSigningInput,
  REMOTE_RUN_OPERATIONS,
  REMOTE_TEAM_ASSET_FILE_METHOD,
  remoteLocalCapabilitiesSchema,
} from '../dist/index.js';
const hash = (value) => createHash('sha256').update(canonicalPayload(value)).digest('hex');
const row = () => ({
  reference: {
    spaceId: 'north',
    assetId: randomUUID(),
    kind: 'file',
    versionId: randomUUID(),
    sha256: 'a'.repeat(64),
  },
  file: { name: 'reference.txt', mediaType: 'text/plain', byteSize: 100, sha256: 'b'.repeat(64) },
});
const snapshot = () => {
  const value = {
    sourceVersion: 'zhuma-native-team-assets@1',
    spaceId: 'north',
    files: [row()],
    sha256: '0'.repeat(64),
  };
  value.sha256 = hash(memberAssetFileSnapshotDigestInput(value));
  return value;
};

test('team asset snapshot DTO: bounded complete references retain independent asset-version and byte digests, never bodies or private handles', () => {
  const value = snapshot();
  MemberAssetFileSnapshotSchema.parse(value);
  assert.equal(
    MemberAssetFileSnapshotSchema.safeParse({ ...value, files: Array.from({ length: 51 }, row) })
      .success,
    false,
  );
  assert.equal(
    MemberAssetFileSnapshotSchema.safeParse({
      ...value,
      files: [{ ...row(), reference: { ...row().reference, spaceId: 'south' } }],
    }).success,
    false,
  );
  assert.equal(
    MemberAssetFileSnapshotSchema.safeParse({
      ...value,
      files: [{ ...value.files[0], file: { ...value.files[0].file, attachmentId: 'private' } }],
    }).success,
    false,
  );
  assert.equal(
    MemberAssetFileSnapshotSchema.safeParse({ ...value, files: [value.files[0], value.files[0]] })
      .success,
    false,
  );
  assert.notEqual(value.files[0].reference.sha256, value.files[0].file.sha256);
  assert.notEqual(
    hash(
      memberAssetFileSnapshotDigestInput({
        ...value,
        files: [{ ...value.files[0], file: { ...value.files[0].file, name: 'changed' } }],
      }),
    ),
    value.sha256,
  );
});

test('team asset signed binary/check DTO: complete mode/scope/fixed ref belongs to the original device signature domain and stays outside generic JSON operations', () => {
  const keys = generateKeyPairSync('ed25519'),
    backendId = randomUUID();
  const value = {
    protocolVersion: 1,
    operation: 'team-asset-file',
    requestId: randomUUID(),
    backendId,
    deviceId: randomUUID(),
    proof: { issuedAt: Date.now(), nonce: randomUUID(), signature: 'A'.repeat(86) },
    payload: {
      mode: 'read',
      permit: { id: randomUUID(), sha256: 'c'.repeat(64) },
      scope: {
        backendId,
        actorId: 'ann',
        spaceId: 'north',
        taskId: 'task',
        planId: 'plan',
        revision: 1,
        nodeId: 'work',
        runId: 'run',
        generation: 1,
        segmentId: 'segment',
      },
      reference: row().reference,
    },
  };
  const parsed = remoteTeamAssetFileReadRequestSchema.parse(value);
  const bytes = Buffer.from(canonicalPayload(remoteDeviceSigningInput(parsed))),
    signature = sign(null, bytes, keys.privateKey);
  for (const candidate of [
    { ...parsed, payload: { ...parsed.payload, mode: 'check' } },
    {
      ...parsed,
      payload: {
        ...parsed.payload,
        reference: { ...parsed.payload.reference, sha256: 'f'.repeat(64) },
      },
    },
  ])
    assert.equal(
      verify(
        null,
        Buffer.from(canonicalPayload(remoteDeviceSigningInput(candidate))),
        keys.publicKey,
        signature,
      ),
      false,
    );
  assert(!REMOTE_RUN_OPERATIONS.includes('team-asset-file'));
  assert.equal(REMOTE_TEAM_ASSET_FILE_METHOD, 'zhuma-remote-run/team-asset-file');
  const legacy = { resultIntent: 'zhuma-native-result-intent@1', localTools: [] };
  assert.deepEqual(remoteLocalCapabilitiesSchema.parse(legacy), legacy);
});

test('legacy source read DTO: space/kind/requirements are public and exact; duplicate, unsupported or oversized dependency slots refuse', () => {
  const value = {
    actorId: 'ann',
    spaceId: 'north',
    source: {
      kind: 'unknown',
      spaceId: 'north',
      assetId: 'source',
      assetKind: 'skill',
      sha256: 'a'.repeat(64),
    },
    definition: { kind: 'skill', name: 'Method', description: '', content: 'Method body' },
    requirements: [{ slotId: 'tool', kind: 'mcp' }],
  };
  MemberAssetLegacySourceValueSchema.parse(value);
  for (const candidate of [
    { ...value, spaceId: 'south' },
    { ...value, definition: { kind: 'file', name: 'Wrong kind', description: '' } },
    { ...value, requirements: [...value.requirements, ...value.requirements] },
    { ...value, requirements: [{ slotId: 'tool', kind: 'shell' }] },
    {
      ...value,
      requirements: Array.from({ length: 101 }, (_, i) => ({ slotId: `slot-${i}`, kind: 'skill' })),
    },
  ])
    assert.equal(MemberAssetLegacySourceValueSchema.safeParse(candidate).success, false);
});
