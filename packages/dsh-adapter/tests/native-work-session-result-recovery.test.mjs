/** Metadata fault contracts; actual OS recovery is covered by the SDK process spec. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeWorkSessionService } from '../dist/native-work-session.js';
import { grant, scope, selection } from './native-work-session-fixture.mjs';

const cut = { callSeq: 2, resultSeq: 3, turnEndSeq: 4, asOfSeq: 4 };
function harness(version) {
  let record = {
    schemaVersion: 1,
    scope: { ...scope },
    nativeSessionId: 'native',
    nativeAgentId: 'native',
    selection: { ...selection },
    receipts: [],
    resultIntent: {
      protocolVersion: version,
      toolVersion: `zhuma-native-result-intent@${version}`,
      intentId: 'intent',
      callId: 'call',
      digest: 'a'.repeat(64),
      ...(version === 2 ? { manifestDigest: 'b'.repeat(64) } : {}),
    },
  };
  let writes = 0;
  const storage = {
    read: () => structuredClone(record),
    async write(_key, value) {
      writes++;
      record = structuredClone(value);
    },
  };
  return {
    service: new NativeWorkSessionService(storage, {}),
    grant: grant(),
    writes: () => writes,
    value: () => structuredClone(record),
  };
}

for (const version of [1, 2]) {
  test(`contract: v${version} result continuation can only read the exact sealed cut and cannot send`, async () => {
    const h = harness(version);
    await h.service.sealResultIntent(h.grant, 'intent', cut, () => undefined);
    const before = h.value();
    const readOnly = grant();
    const original = readOnly.assertCurrent;
    readOnly.assertCurrent = (action) => {
      original();
      if (!['open', 'history'].includes(action)) throw Error('result-continuation-is-not-drive');
    };
    const binding = await h.service.readSealedResultIntent(
      readOnly,
      'intent',
      cut,
      () => undefined,
    );
    assert.deepEqual(binding, before);
    assert.equal(h.writes(), 1);
    assert.throws(
      () =>
        h.service.send(readOnly, {
          requestId: 'must-not-send',
          text: 'must-not-start',
          mode: 'followup',
          selection,
        }),
      /result-continuation-is-not-drive/u,
    );
    assert.throws(
      () => h.service.sealResultIntent(readOnly, 'intent', cut, () => undefined),
      /result-continuation-is-not-drive/u,
    );
    assert.deepEqual(h.value(), before);
  });

  test(`contract: v${version} read-only continuation cannot manufacture an unsealed cut or reuse changed source authority`, async () => {
    const h = harness(version);
    await assert.rejects(
      h.service.readSealedResultIntent(h.grant, 'intent', cut, () => undefined),
      { code: 'scope-mismatch' },
    );
    assert.equal(h.writes(), 0);
    await h.service.sealResultIntent(h.grant, 'intent', cut, () => undefined);
    await assert.rejects(
      h.service.readSealedResultIntent(h.grant, 'intent', { ...cut, asOfSeq: 5 }, () => undefined),
      { code: 'idempotency-mismatch' },
    );
    await assert.rejects(
      h.service.readSealedResultIntent(h.grant, 'intent', cut, () => {
        h.grant.deny();
        return undefined;
      }),
    );
    assert.equal(h.writes(), 1);
  });

  test(`contract: v${version} first cut persists once and requalified recovery does not rewrite it`, async () => {
    const h = harness(version);
    const first = await h.service.sealResultIntent(h.grant, 'intent', cut, () => undefined);
    assert.equal(h.writes(), 1);
    const original = h.value();
    let validations = 0;
    const restored = await h.service.sealResultIntent(h.grant, 'intent', cut, () => {
      validations++;
      return undefined;
    });
    assert.equal(validations, 2);
    assert.equal(h.writes(), 1);
    assert.deepEqual(restored, first);
    assert.deepEqual(h.value(), original);
    restored.resultIntent.cut.asOfSeq++;
    assert.deepEqual(h.value(), original);
  });

  test(`contract: v${version} recovery still refuses changed cut, intent and failed source without writing`, async () => {
    const h = harness(version);
    await h.service.sealResultIntent(h.grant, 'intent', cut, () => undefined);
    const original = h.value();
    await assert.rejects(
      h.service.sealResultIntent(h.grant, 'intent', { ...cut, asOfSeq: 5 }, () => undefined),
      { code: 'idempotency-mismatch' },
    );
    await assert.rejects(
      h.service.sealResultIntent(h.grant, 'other', cut, () => undefined),
      {
        code: 'scope-mismatch',
      },
    );
    await assert.rejects(
      h.service.sealResultIntent(h.grant, 'intent', cut, () => {
        throw Error('original source changed');
      }),
      /original source changed/u,
    );
    assert.equal(h.writes(), 1);
    assert.deepEqual(h.value(), original);
  });

  test(`contract: v${version} no-write recovery retains the authority recheck after source validation`, async () => {
    const h = harness(version);
    await h.service.sealResultIntent(h.grant, 'intent', cut, () => undefined);
    const original = h.value();
    await assert.rejects(
      h.service.sealResultIntent(h.grant, 'intent', cut, () => {
        h.grant.deny();
        return undefined;
      }),
    );
    assert.equal(h.writes(), 1);
    assert.deepEqual(h.value(), original);
  });
}
