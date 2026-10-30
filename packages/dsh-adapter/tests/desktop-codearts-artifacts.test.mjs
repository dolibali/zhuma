/** Physical release-gate contracts; ASAR metadata is a fixture. Original writer proof is separate. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  codeArtsLaunchFiles,
  packagedWorkbench,
  verifyPackagedCodeArts,
} from '../../../scripts/lib/desktop-codearts-artifacts.mjs';

test('release gate requires all three same-byte regular unpacked CodeArts artifacts', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'zhuma-physical-artifacts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const expected = join(directory, 'expected');
  const resources = join(directory, 'resources');
  const physical = join(resources, 'app.asar.unpacked', packagedWorkbench);
  await mkdir(expected);
  await mkdir(physical, { recursive: true });
  const bytes = new Map(codeArtsLaunchFiles.map((file) => [file, Buffer.from(`fixture ${file}`)]));
  for (const [file, value] of bytes) {
    await writeFile(join(expected, file), value);
    await writeFile(join(physical, file), value);
  }
  const asar = {
    statFile: () => ({ unpacked: true }),
    extractFile: (_archive, entry) => bytes.get(entry.split('/').at(-1)),
  };
  assert.deepEqual(
    Object.keys(verifyPackagedCodeArts(resources, expected, asar)),
    codeArtsLaunchFiles,
  );
  assert.throws(
    () => verifyPackagedCodeArts(resources, expected, { ...asar, statFile: () => ({}) }),
    /must be unpacked/u,
  );
  assert.throws(
    () =>
      verifyPackagedCodeArts(resources, expected, {
        ...asar,
        extractFile: () => Buffer.from('other'),
      }),
    /ASAR CodeArts bytes differ/u,
  );
  const file = codeArtsLaunchFiles[0];
  await writeFile(join(physical, file), 'changed');
  assert.throws(
    () => verifyPackagedCodeArts(resources, expected, asar),
    /Physical CodeArts bytes differ/u,
  );
  await rm(join(physical, file));
  assert.throws(() => verifyPackagedCodeArts(resources, expected, asar), /ENOENT/u);
  await symlink(join(expected, file), join(physical, file));
  assert.throws(() => verifyPackagedCodeArts(resources, expected, asar), /regular physical file/u);
});
