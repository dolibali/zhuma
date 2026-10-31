#!/usr/bin/env node
/** Generate an explicit private launch patch. Never run the launcher, inspect
 * a user profile, change settings or claim model/login readiness. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    node: { type: 'string' },
    launcher: { type: 'string' },
    bundle: { type: 'string' },
    out: { type: 'string' },
  },
  strict: true,
  allowPositionals: false,
});
if (
  !values.node ||
  !values.launcher ||
  !values.bundle ||
  !values.out ||
  !isAbsolute(values.node) ||
  !isAbsolute(values.launcher)
)
  throw Error(
    'Pass --node and --launcher as explicit absolute executables, plus --bundle and --out.',
  );
const directory = resolve(values.bundle),
  manifest = JSON.parse(await readFile(join(directory, 'codearts-acp.manifest.json'), 'utf8'));
if (
  manifest.schemaVersion !== 1 ||
  manifest.entry !== 'codearts-acp.js' ||
  manifest.acpProtocolSdk !== '1.5.1' ||
  !/^[a-f0-9]{64}$/u.test(manifest.sha256) ||
  !/^[a-f0-9]{64}$/u.test(manifest.policySha256)
)
  throw Error('Unexpected CodeArts bundle manifest.');
async function artifact(file) {
  const path = await realpath(file),
    hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { path, sha256: hash.digest('hex') };
}
const artifacts = {
  node: await artifact(values.node),
  adapter: await artifact(join(directory, manifest.entry)),
  launcher: await artifact(values.launcher),
};
if (artifacts.adapter.sha256 !== manifest.sha256)
  throw Error('CodeArts entry differs from the exact bundle manifest.');
const policyFile = join(directory, 'codearts-policy.js');
if ((await artifact(policyFile)).sha256 !== manifest.policySha256)
  throw Error('CodeArts policy differs from the exact bundle manifest.');
const { createCodeArtsProfileRegistration } = await import(pathToFileURL(policyFile).href);
const lifetime = new AbortController();
try {
  const registration = await createCodeArtsProfileRegistration({
    ...artifacts,
    signal: lifetime.signal,
  });
  const patch = [
    { id: 'zhuma-codearts-policy', config: { artifacts } },
    {
      id: 'dsh-acp-adapter',
      config: { agents: { [registration.profileId]: registration.profile } },
    },
  ];
  await writeFile(resolve(values.out), JSON.stringify(patch, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  registration.revoke();
  console.log(
    'Private launch patch generated. Apply explicitly to the matching product composition; this did not run CodeArts or change settings.',
  );
} finally {
  lifetime.abort();
}
