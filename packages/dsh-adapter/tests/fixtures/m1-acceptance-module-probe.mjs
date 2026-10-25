/**
 * Boots the acceptance Host once. Exit 0 only when that boot succeeds.
 * Callers set `S1A_HOST_MODULE` to the entry under test.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAcceptanceHost } from './m1-acceptance-harness.mjs';

const directory = await mkdtemp(join(tmpdir(), 'zhuma-m1-module-'));
try {
  const host = await startAcceptanceHost(directory, {
    deploymentMode: 'multi-member',
    workbenchSeed: [],
  });
  await host.close();
} catch (error) {
  process.stdout.write(`${error instanceof Error ? error.message : 'failed'}\n`);
  process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
