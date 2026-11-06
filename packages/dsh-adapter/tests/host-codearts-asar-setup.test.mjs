/** Isolate the original Loader's process-wide hooks for each synthetic ASAR layout. */
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const policy of ['logical', 'physical'])
  test(
    `CodeArts ASAR setup with ${policy} Loader URL`,
    {
      skip: !process.env.ZHUMA_CODEARTS_LOADER_MODULE || !process.env.ZHUMA_CODEARTS_BUNDLE,
      timeout: 30_000,
    },
    () => {
      execFileSync(
        process.execPath,
        [
          '--test',
          '--test-name-pattern=CodeArts normal setup',
          fileURLToPath(new URL('./host-codearts-setup.test.mjs', import.meta.url)),
        ],
        {
          env: {
            ...process.env,
            ZHUMA_CODEARTS_LAYOUT: 'asar',
            ZHUMA_CODEARTS_POLICY_PHYSICAL: policy === 'physical' ? '1' : '',
          },
          stdio: 'pipe',
          timeout: 25_000,
        },
      );
    },
  );
