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
  const clientFileProof = join(runtime, 'client-files-proof.json');
  const teamCatalogProof = join(runtime, 'team-catalog-proof.json');
  const firstSetupProof = join(runtime, 'first-setup-proof.json');
  const memberAssetsProof = join(runtime, 'member-assets-proof.json');
  const child = spawn(
    process.execPath,
    [
      '--test',
      'packages/dsh-adapter/tests/s1a-host.test.mjs',
      'packages/dsh-adapter/tests/member-file-client-host.test.mjs',
      'packages/dsh-adapter/tests/host-team-catalog.test.mjs',
      'packages/dsh-adapter/tests/host-first-setup.test.mjs',
      'packages/dsh-adapter/tests/member-assets-host.test.mjs',
    ],
    {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        S1A_HOST_MODULE: join(runtime, 'index.js'),
        S1A_PROOF_FILE: temporaryProof,
        S1A_CLIENT_FILE_PROOF_FILE: clientFileProof,
        S1A_TEAM_CATALOG_PROOF_FILE: teamCatalogProof,
        S1A_FIRST_SETUP_PROOF_FILE: firstSetupProof,
        S1A_MEMBER_ASSET_PROOF_FILE: memberAssetsProof,
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
    if (proof.cases.length !== 9 || proof.cases.some((entry) => entry.passed !== true))
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
          'scripts/lib/team-starter-packages.mjs',
          'distribution/workbench',
          'patches/deepseek-harness',
          'resources/experts/starter-pack',
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
    const fileClient = JSON.parse(await readFile(clientFileProof, 'utf8'));
    if (
      !fileClient.passed ||
      fileClient.hostSha256 !== proof.artifact['index.js'] ||
      fileClient.sourceHead !== proof.sourceHead
    )
      throw Error('Incomplete or crossed Client file Host proof');
    proof.clientFiles = {
      ...fileClient,
      fixtureSha256: sha(
        await readFile(join(root, 'packages/dsh-adapter/tests/member-file-client-host.test.mjs')),
      ),
    };
    const teamCatalog = JSON.parse(await readFile(teamCatalogProof, 'utf8'));
    if (
      !teamCatalog.passed ||
      !teamCatalog.sameHostBytes ||
      !teamCatalog.separateProcesses ||
      teamCatalog.seededPlan ||
      teamCatalog.modelCalls !== 0 ||
      teamCatalog.hostSha256 !== proof.artifact['index.js'] ||
      teamCatalog.sourceHead !== proof.sourceHead
    )
      throw Error('Incomplete or crossed team catalog Host proof');
    proof.teamCatalog = teamCatalog;
    const firstSetup = JSON.parse(await readFile(firstSetupProof, 'utf8'));
    if (
      firstSetup.cases.length !== 2 ||
      firstSetup.cases.some(
        (entry) =>
          !entry.passed ||
          entry.sourceHead !== proof.sourceHead ||
          entry.hostSha256 !== proof.artifact['index.js'],
      )
    )
      throw Error('Incomplete or crossed normal first-setup Host proof');
    proof.firstSetup = firstSetup;
    const memberAssets = JSON.parse(await readFile(memberAssetsProof, 'utf8'));
    if (
      !memberAssets.normalMemberHttp ||
      memberAssets.seeded !== false ||
      memberAssets.processes !== 2 ||
      memberAssets.sourceHead !== proof.sourceHead ||
      memberAssets.hostSha256 !== proof.artifact['index.js'] ||
      memberAssets.catalogCount !== 1
    )
      throw Error('Incomplete or crossed normal member assets Host proof');
    proof.memberAssets = memberAssets;
    proof.scope =
      'Exact emitted bundle; nine real-service subprocess cases plus public Client file HTTP delivery/review/downstream, public team catalog member creation/confirmation/cold reopen, and normal first setup/catalog-prefix crash with explicit same-context recovery, and normal member asset metadata/upload/publish/catalog/read across two OS processes; a private temporary SDK package link; no installed-desktop or model-quality claim.';
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
        clientFileHostCase: proof.clientFiles.passed,
        teamCatalogHostCase: proof.teamCatalog.passed,
        firstSetupHostCases: proof.firstSetup.cases.length,
        memberAssetsHostCase: proof.memberAssets.normalMemberHttp,
      }),
    );
  }
} finally {
  await rm(runtime, { recursive: true, force: true });
}
