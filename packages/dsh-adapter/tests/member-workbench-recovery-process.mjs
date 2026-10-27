/** Isolated test worker. Each boot is a new OS process over the same DSH JSON domains. */
import { startMemberWorkbenchHost } from './member-workbench-host.mjs';
import { catalogForMode } from './member-workbench-catalog-fixture.mjs';
process.once('message', async ({ home, faultStage, commands = [], revoke, crash, catalogMode }) => {
  let host;
  try {
    host = await startMemberWorkbenchHost(home, {
      faultStage,
      ...(catalogMode ? { catalog: async () => catalogForMode(catalogMode) } : {}),
    });
    const cookie = await host.login('ann');
    if (revoke) await host.directory.revokeMembership('north', 'ann');
    const before = host.service.snapshot().revision;
    const responses = [];
    for (const command of commands)
      responses.push((await host.rpc('command', command, cookie)).json.result);
    const state = host.service.snapshot();
    if (!crash) {
      await host.close();
      host = undefined;
    }
    process.send({
      ok: true,
      before,
      revision: state.revision,
      projectCount: state.projects.length,
      taskCount: state.tasks.length,
      planCount: state.appliedPlans.length,
      responses,
    });
    if (crash) await new Promise(() => {}); // parent SIGKILL proves no close-time flushing is required
  } catch (error) {
    process.send({ ok: false, error: error.message });
  } finally {
    if (host) await host.close();
    process.disconnect();
  }
});
