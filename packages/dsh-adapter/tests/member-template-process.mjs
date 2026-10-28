/** New OS process over original published DSH JSON/identity/HTTP components. */
import { startMemberWorkbenchHost } from './member-workbench-host.mjs';
import { catalog } from './member-template-fixture.mjs';
process.once(
  'message',
  async ({ home, commands = [], faultStage, actor = 'ann', revoke, changedCatalog }) => {
    let host;
    try {
      host = await startMemberWorkbenchHost(home, {
        faultStage,
        catalog: async (spaceId) => {
          const value = catalog();
          if (changedCatalog)
            value.assets[0].content = value.assets[0].content.replace('主流程', '新的主流程');
          return spaceId === 'north' ? value : { experts: [], assets: [] };
        },
      });
      const cookie = await host.login(actor);
      if (revoke) await host.directory.revokeMembership('north', actor);
      const before = host.service.snapshot();
      const responses = [];
      for (const command of commands)
        responses.push((await host.rpc('command', command, cookie)).json.result);
      const state = host.service.snapshot();
      await host.close();
      host = undefined;
      process.send({ ok: true, before, state, responses });
    } catch (error) {
      process.send({ ok: false, error: error.message });
    } finally {
      if (host) await host.close();
      process.disconnect();
    }
  },
);
