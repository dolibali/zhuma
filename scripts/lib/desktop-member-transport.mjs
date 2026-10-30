import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** Read-only gate for staging a plugin into an already built official SDK.
 * Copying a newer TS source alone does not update Electron's compiled bridge. */
export async function verifyDesktopMemberTransport(stage, expectedSource) {
  const expected = await readFile(expectedSource),
    copied = await readFile(join(stage, 'apps/desktop/src/zhuma-member-cookie.ts')),
    main = await readFile(join(stage, 'apps/desktop/lib/main.js'));
  if (sha(expected) !== sha(copied))
    throw Error(
      'Prepared desktop member transport is stale; synchronize the matching official build source.',
    );
  const pattern = expected.toString('utf8').match(/const MEMBER_PATH\s*=\s*(\/[^\r\n]+\/);/u)?.[1];
  if (!pattern || !main.toString('utf8').includes(pattern))
    throw Error(
      'Compiled desktop member routes are stale; rebuild the official desktop main before staging.',
    );
  return { sourceSha256: sha(expected), routePatternSha256: sha(pattern), mainSha256: sha(main) };
}
