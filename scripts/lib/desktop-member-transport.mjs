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
  const patterns = ['MEMBER_PATH', 'OWNER_POST_PATH'].map((name) => {
    const pattern = expected
      .toString('utf8')
      .match(new RegExp(`const ${name}\\s*=\\s*(/[^\\r\\n]+/);`, 'u'))?.[1];
    if (!pattern || !main.toString('utf8').includes(pattern))
      throw Error(
        `Compiled desktop member routes or owner POST policy (${name}) are stale; rebuild the official desktop main before staging.`,
      );
    return sha(pattern);
  });
  return {
    sourceSha256: sha(expected),
    routePatternSha256: patterns[0],
    ownerPostPatternSha256: patterns[1],
    mainSha256: sha(main),
  };
}
