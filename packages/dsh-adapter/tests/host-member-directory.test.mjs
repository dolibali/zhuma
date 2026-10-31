/** Original domain/directory projections; account/session issuer is the explicit
 * fixture contract, not login or GUI acceptance. No membership value is cached. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { assetHost } from './member-asset-host-fixture.mjs';
import { identityDomainSpec } from '../dist/identity-session.js';
import { createHostMemberDirectory } from '../dist/host-member-directory.js';

test('Host directory projection keeps owner identity stable, reads live membership and rejects retired namespaces', async (t) => {
  const f = await assetHost(t);
  const identity = await f.ctx.storageDomain.open(identityDomainSpec);
  const current = createHostMemberDirectory(f.ctx);
  const original = current();
  assert.ok(original);
  assert.equal(current(), original);
  assert.equal(original.isMember('north', 'bob'), true);
  await f.revoke('north', 'bob');
  assert.equal(current(), original);
  assert.equal(original.isMember('north', 'bob'), false, 'same wrapper must not cache membership');
  await f.replaceDirectory();
  const replacement = current();
  assert.ok(replacement);
  assert.notEqual(replacement, original);
  assert.throws(
    () => original.space('north'),
    (error) => error.code === 'unavailable',
  );
  assert.equal(current(), replacement);
  await identity.close();
  assert.equal(current(), undefined, 'a missing identity owner cannot keep an old projection');
});
