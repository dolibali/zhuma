/** Check the one packaged carrier used by the normal CodeArts setup/child argv. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const codeArtsLaunchFiles = [
  'codearts-acp.js',
  'codearts-acp.manifest.json',
  'codearts-policy.js',
];
export const packagedWorkbench = 'dsh/node_modules/@deepseek-ai/dsh-web-app/lib/zhuma-workbench';

export function verifyPackagedCodeArts(resources, expected, asar) {
  const archive = join(resources, 'app.asar');
  return Object.fromEntries(
    codeArtsLaunchFiles.map((file) => {
      const entry = `${packagedWorkbench}/${file}`;
      assert.equal(
        asar.statFile(archive, entry).unpacked,
        true,
        'CodeArts artifact must be unpacked.',
      );
      const physical = join(`${archive}.unpacked`, entry);
      assert(lstatSync(physical).isFile(), 'CodeArts artifact must be a regular physical file.');
      const bytes = readFileSync(physical);
      assert(bytes.equals(readFileSync(join(expected, file))), 'Physical CodeArts bytes differ.');
      assert(bytes.equals(asar.extractFile(archive, entry)), 'ASAR CodeArts bytes differ.');
      return [file, createHash('sha256').update(bytes).digest('hex')];
    }),
  );
}
