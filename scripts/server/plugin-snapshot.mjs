import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const files = [
  'index.js',
  'member-web.js',
  'client.js',
  'package.json',
  'LICENSE',
  'THIRD_PARTY_LICENSES.txt',
];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Immutable PUBLIC plugin material only; never reads a profile or credential.
 * A frozen candidate cannot be rebound to the next mutable workbench build. */
export async function snapshotServerPlugin({ source, sdkRoot, pin, outputRoot, frozen = false }) {
  const manifest = frozen
    ? JSON.parse(await readFile(join(source, 'A-SOURCE.json'), 'utf8'))
    : undefined;
  if (
    manifest &&
    (!/^[a-f0-9]{40}$/u.test(manifest.head) ||
      !/^[a-f0-9]{40}$/u.test(manifest.tree) ||
      manifest.sdkPin !== pin)
  )
    throw new Error('Invalid frozen server product source identity');
  const bytes = new Map();
  for (const file of files) {
    const data = await readFile(join(source, file));
    if (manifest && manifest.hashes?.[file] !== sha(data))
      throw new Error('Frozen server product bytes differ');
    bytes.set(file, data);
  }
  if (JSON.parse(bytes.get('package.json').toString('utf8')).name !== '@zhuma/workbench')
    throw new Error('Unexpected server product identity');
  const digest = createHash('sha256').update(sdkRoot);
  for (const [file, data] of bytes) digest.update(file).update(sha(data));
  const runtime = join(outputRoot, digest.digest('hex'));
  await mkdir(runtime, { recursive: true });
  for (const [file, data] of bytes) {
    try {
      await writeFile(join(runtime, file), data, { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (sha(await readFile(join(runtime, file))) !== sha(data))
        throw new Error('Existing immutable server snapshot differs');
    }
  }
  return runtime;
}
