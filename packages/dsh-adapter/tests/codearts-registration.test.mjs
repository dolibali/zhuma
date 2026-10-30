/** Local registration contracts only; synthetic files do not qualify a real CLI. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CODEARTS_PROFILE_ID,
  createCodeArtsProfileRegistration,
  CodeArtsProfileRegistrationProducer,
} from '../dist/executors/codearts/registration.js';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'zhuma-codearts-registration-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  const input = { signal: controller.signal };
  for (const name of ['node', 'adapter', 'launcher']) {
    const body = `synthetic-${name}-never-executed`;
    const path = join(root, name);
    await writeFile(path, body);
    input[name] = { path, sha256: createHash('sha256').update(body).digest('hex') };
  }
  return { input, controller };
}

test('CodeArts registration: exact verified spec, immutable config and opaque generation', async (t) => {
  const { input } = await fixture(t);
  const registration = await createCodeArtsProfileRegistration(input);
  assert.equal(registration.profileId, CODEARTS_PROFILE_ID);
  assert.deepEqual(registration.profile.args, [
    input.adapter.path,
    '--codearts-command',
    input.launcher.path,
  ]);
  assert.deepEqual(registration.profile.env, { ELECTRON_RUN_AS_NODE: '1' });
  assert.equal(registration.matches('unrelated', {}), false);
  const guard = registration.guardForProfile(
    CODEARTS_PROFILE_ID,
    structuredClone(registration.profile),
  );
  assert.equal(typeof guard, 'function');
  assert.equal(guard(), true);
  assert.throws(() => registration.profile.args.push('injected'));
  assert.throws(() => {
    registration.profile.env.EXTRA = 'injected';
  });
  assert.deepEqual(Object.keys(registration.generation), []);
  registration.revoke();
  assert.equal(guard(), false);
  assert.equal(registration.guardForProfile(CODEARTS_PROFILE_ID, registration.profile), undefined);
});

test('CodeArts registration: any complete-profile mutation permanently retires the generation', async (t) => {
  const { input } = await fixture(t);
  for (const modify of [
    (p) => {
      p.name = 'other';
    },
    (p) => {
      p.command += '-other';
    },
    (p) => {
      p.args.push('extra');
    },
    (p) => {
      p.env.EXTRA = 'extra';
    },
    (p) => {
      p.runtime = 'codex';
    },
    (p) => {
      p.catalogId = 'same-name';
    },
    (p) => {
      p.loginHint = 'other';
    },
  ]) {
    const registration = await createCodeArtsProfileRegistration(input);
    const guard = registration.guardForProfile(CODEARTS_PROFILE_ID, registration.profile);
    const changed = structuredClone(registration.profile);
    modify(changed);
    assert.equal(registration.matches(CODEARTS_PROFILE_ID, changed), false);
    assert.equal(guard(), false);
    assert.equal(registration.matches(CODEARTS_PROFILE_ID, registration.profile), false);
  }
});

test('CodeArts registration: replacement and disposal invalidate old handed-out closures', async (t) => {
  const { input } = await fixture(t);
  const producer = new CodeArtsProfileRegistrationProducer();
  const first = await producer.prepare(input);
  const oldGuard = producer.guardForProfile(first.profileId, first.profile);
  const second = await producer.prepare(input);
  assert.notEqual(first.generation, second.generation);
  assert.equal(oldGuard(), false);
  const guard = producer.guardForProfile(second.profileId, second.profile);
  assert.equal(guard(), true);
  producer.dispose();
  assert.equal(guard(), false);
  assert.equal(producer.guardForProfile(second.profileId, second.profile), undefined);
});

test('CodeArts registration: parent abort, changed file and late preparation fail closed', async (t) => {
  const { input, controller } = await fixture(t);
  const registered = await createCodeArtsProfileRegistration(input);
  controller.abort();
  assert.equal(registered.isCurrent(), false);
  await assert.rejects(createCodeArtsProfileRegistration(input), {
    name: 'CodeArtsRegistrationError',
  });
  const fresh = { ...input, signal: new AbortController().signal };
  const changed = await createCodeArtsProfileRegistration(fresh);
  await writeFile(input.adapter.path, 'different bytes');
  assert.equal(changed.isCurrent(), false);
  await assert.rejects(
    createCodeArtsProfileRegistration(fresh),
    (error) =>
      error.name === 'CodeArtsRegistrationError' && !error.message.includes(input.adapter.path),
  );
  await writeFile(input.adapter.path, 'synthetic-adapter-never-executed');
  assert.equal(changed.isCurrent(), false);
  const producer = new CodeArtsProfileRegistrationProducer();
  const pending = producer.prepare(fresh);
  producer.dispose();
  await assert.rejects(pending, { name: 'CodeArtsRegistrationError' });
});
