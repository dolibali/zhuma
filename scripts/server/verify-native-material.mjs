#!/usr/bin/env node
/** Verifies the original native POSIX flock, not a JS lock substitute. */
import assert from 'node:assert/strict';
import { open, mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../..', import.meta.url));
const { values } = parseArgs({ options: { sdk: { type: 'string' } } });
if (!values.sdk) throw new Error('Pass --sdk with the owned public SDK cut');
const sdk = resolve(values.sdk);
const { tryLockExclusive } = await import(
  pathToFileURL(join(sdk, 'native/system/packages/entry/lib/flock.js')).href
);
const directory = await mkdtemp(join(tmpdir(), 'zhuma-native-material-'));
let first, second;
try {
  first = await open(join(directory, 'synthetic.lock'), 'w+');
  second = await open(join(directory, 'synthetic.lock'), 'r+');
  await tryLockExclusive(first.fd);
  await assert.rejects(tryLockExclusive(second.fd), (error) =>
    ['EAGAIN', 'EWOULDBLOCK'].includes(error.code),
  );
  await first.close();
  first = undefined;
  await tryLockExclusive(second.fd);
  const material = JSON.parse(
    await readFile(join(root, '.build/desktop/member-sdk-native-extension.json'), 'utf8'),
  );
  const sha = createHash('sha256')
    .update(await readFile(join(sdk, 'packages/api/gateway/lib/index.js')))
    .digest('hex');
  assert.equal(sha, material.gateway);
  const report = {
    scope: 'actual-original-native-posix-flock-synthetic-file-no-agent-model-profile',
    checks: [
      'native-addon-load-and-lock',
      'actual-exclusive-contention',
      'descriptor-close-releases-lock',
      'frozen-gateway-unchanged',
    ],
    pin: material.pin,
    nativeMaterials: material.nativeMaterials,
    gateway: sha,
    limits: ['No Agent/session persistence/model/two-Host acceptance'],
  };
  await mkdir(join(root, '.artifacts/server'), { recursive: true });
  await writeFile(
    join(root, '.artifacts/server/native-material-proof.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await first?.close();
  await second?.close();
  await rm(directory, { recursive: true, force: true });
}
