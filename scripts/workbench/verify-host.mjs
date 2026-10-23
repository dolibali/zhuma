import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const runtime = await mkdtemp(join(tmpdir(), 'zhuma-host-artifact-'));
const sha = (value) => createHash('sha256').update(value).digest('hex');
try {
  // Exercise the emitted bytes in a normal SDK package scope, as the official
  // bundle does. Credentials/storage/HTTP are real; model generation rejects.
  // No source re-bundle, user profile or model call is involved.
  const names = ['index.js', 'client.js', 'package.json', 'THIRD_PARTY_LICENSES.txt'];
  for (const name of names)
    await copyFile(join(root, '.build/workbench', name), join(runtime, name));
  await symlink(
    join(root, 'packages/dsh-adapter/node_modules'),
    join(runtime, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const temporaryProof = join(runtime, 'proof.json');
  const child = spawn(
    process.execPath,
    ['--test', 'packages/dsh-adapter/tests/s1a-host.test.mjs'],
    {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        S1A_HOST_MODULE: join(runtime, 'index.js'),
        S1A_PROOF_FILE: temporaryProof,
      },
    },
  );
  const code = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', resolveExit);
  });
  if (code !== 0) process.exitCode = code ?? 1;
  else {
    const proof = JSON.parse(await readFile(temporaryProof, 'utf8'));
    if (proof.cases.length !== 6 || proof.cases.some((entry) => entry.passed !== true))
      throw Error('Incomplete Host artifact proof');
    proof.sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    proof.sourceClean =
      execFileSync(
        'git',
        [
          'status',
          '--porcelain',
          '--',
          'packages',
          'scripts/workbench',
          'distribution/workbench',
          'package.json',
          'pnpm-lock.yaml',
        ],
        { cwd: root, encoding: 'utf8' },
      ).trim() === '';
    proof.artifact = Object.fromEntries(
      await Promise.all(
        names.map(async (name) => [name, sha(await readFile(join(runtime, name)))]),
      ),
    );
    proof.scope =
      'Exact emitted bundle; six real-service subprocess cases; a private temporary SDK package link; no installed-desktop or model-quality claim.';
    if (process.env.S1A_PROOF_FILE) {
      const target = resolve(process.env.S1A_PROOF_FILE);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, JSON.stringify(proof, null, 2) + '\n');
    }
    console.log(
      JSON.stringify({
        sourceHead: proof.sourceHead,
        hostSha256: proof.artifact['index.js'],
        clientSha256: proof.artifact['client.js'],
        realServiceCases: proof.cases.length,
      }),
    );
  }
} finally {
  await rm(runtime, { recursive: true, force: true });
}
