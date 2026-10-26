// Data preparation only; the mounted emitted Host must own all actual services,
// member authorization, Run grants and native effects in the acceptance fixture.
export { applyWorkbenchCommand } from '@zhuma/agent-core';
export { hashPassword } from '../src/identity-session.js';
export { fixture } from '../../../tests/fixtures/workbench.mjs';
import { WorkbenchService } from '../src/workbench-service.js';

// Import/confirmed-plan preparation only. Actual private reads below belong to
// the mounted Host and its original package domain, not this seed service.
export async function importedSkillSeed(state, userOnly = false) {
  const records = new Map();
  const service = new WorkbenchService(
    {
      read: () => state,
      write: async (next) => {
        state = next;
      },
    },
    { get: () => undefined, put: async () => {} },
    {
      get: (id) => records.get(id),
      put: async (record) => {
        records.set(record.versionId, record);
      },
    },
  );
  await service.command(
    {
      requestId: 'seed-package',
      expectedRevision: state.revision,
      command: {
        type: 'import-package',
        input: {
          versionId: '34ca834b-18f3-458e-8a37-5bb52e0ae57b',
          files: [
            {
              path: 'demo/SKILL.md',
              data: Buffer.from(
                `---\nname: demo\ndescription: Selected original package\n${userOnly ? 'disable-model-invocation: true\n' : ''}---\nSELECTED_ORIGINAL_SKILL_BODY`,
              ).toString('base64'),
            },
          ],
          choices: [
            {
              key: 'demo/SKILL.md',
              id: 'api-skill',
              replace: true,
              name: 'Selected original package',
              description: 'Selected original package',
              role: '',
              capabilities: [],
              available: true,
            },
          ],
        },
      },
    },
    new AbortController().signal,
  );
  return { state, record: [...records.values()][0] };
}
