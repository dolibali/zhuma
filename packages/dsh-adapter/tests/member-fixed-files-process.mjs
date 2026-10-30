/** Separate OS process over controlled original JSON/attachments, no real profile. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixedFilesHost } from './member-fixed-files-fixture.mjs';
import { signal } from './member-workbench-fixture.mjs';
const [root, locator] = process.argv.slice(2),
  hooks = [];
const h = await fixedFilesHost({ after: (fn) => hooks.push(fn) }, { root });
try {
  const input = JSON.parse(await readFile(locator, 'utf8'));
  const before = h.workbench.snapshot().revision;
  if (input.request) await h.member().command(input.request, signal());
  const state = h.workbench.snapshot();
  const task = input.planId
    ? state.appliedPlans.find((plan) => plan.id === input.planId).task
    : state.tasks.find((task) => task.id === input.taskId);
  assert.deepEqual(task.fileRefs, [input.reference]);
  const snapshot = await h.owner.fileSnapshot(
    h.requests.ann,
    {
      spaceId: 'north',
      references: task.fileRefs,
    },
    signal(),
  );
  assert.deepEqual(
    snapshot.snapshot.files.map((item) => item.reference),
    [input.reference],
  );
  const file = await h.files.read(
    h.requests.ann,
    {
      spaceId: 'north',
      assetId: input.reference.assetId,
      versionId: input.reference.versionId,
    },
    signal(),
  );
  assert.equal(Buffer.from(file.bytes).toString(), input.text);
  assert.equal(h.workbench.snapshot().revision, before);
  process.stdout.write(
    JSON.stringify({ fixedOldVersion: true, actualBytes: true, replayWithoutWrite: true }),
  );
} finally {
  for (const hook of hooks) await hook();
}
