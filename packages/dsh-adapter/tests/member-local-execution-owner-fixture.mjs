import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import Sessions from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import Agents from '@deepseek-ai/dsh-agent';
import Loop from '@deepseek-ai/dsh-agent-loop';
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import Storage from '@deepseek-ai/dsh-storage';
import * as JsonStorage from '@deepseek-ai/dsh-storage-json';
import * as Domain from '@deepseek-ai/dsh-storage-domain';
import FsLocal from '@deepseek-ai/dsh-fs-local';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import WorkspaceRegistry, { WorkspaceId } from '@deepseek-ai/dsh-workspace';
export { SessionId } from '@deepseek-ai/dsh-session';
import { MemberLocalExecutionOwner } from '../dist/member-local-execution-owner.js';
import { ScriptedAdapter } from './native-work-session-fixture.mjs';
export { response } from './native-work-session-fixture.mjs';
export { toolResponse } from './native-work-session-input-fixture.mjs';
export { fixture } from './member-local-execution-protocol-fixture.mjs';
export { MemberLocalExecutionProtocol } from '../dist/member-local-execution-protocol.js';
export { MemberLocalExecutionSecrets } from '../dist/member-local-execution-secrets.js';
export { acceptedInputRef } from '../dist/native-work-session-input-tool.js';
export { canonicalPayload } from '@zhuma/agent-core';
export { createVerifiedTeamAssetFile } from '../dist/team-asset-file-carrier.js';

/** Actual original SDK Host/profile; provider output is scripted, backend authority
 * is separately labelled a contract. No alternative Agent factory is installed. */
export async function bootLocalOwner(root, protocol, options = {}) {
  const ctx = new Context(),
    adapter = new ScriptedAdapter(options.script ?? []);
  try {
    for (const [plugin, config] of [
      [LlmRuntime],
      [Sessions],
      [Projections],
      [Prompt],
      [Tools],
      [Agents],
      [Persistence, { root: join(root, 'sessions'), compression: 'none' }],
      [Loop, { agents: [] }],
      [Storage],
      [JsonStorage, { root: join(root, 'domains') }],
      [Domain, { backend: 'json' }],
      [FsLocal, { cwd: root }],
      [WorkingDirectory, { defaultDirectory: root }],
      [WorkspaceRegistry],
    ])
      await ctx.plugin(plugin, config);
    ctx.llm.registerAdapter(['contract'], adapter);
    let workspace;
    if (options.workspace === true) {
      await mkdir(join(root, 'selected-project'), { recursive: true });
      workspace = await ctx.workspaceRegistry.create(join(root, 'selected-project'));
    } else if (typeof options.workspace === 'string') {
      workspace = ctx.workspaceRegistry.get(WorkspaceId(options.workspace));
      if (!workspace) throw Error('Selected fixture workspace missing');
    }
    const owner = await MemberLocalExecutionOwner.open(ctx, {
      protocol,
      ...(options.review ? { review: options.review } : {}),
      ...(options.knowledge ? { knowledge: options.knowledge } : {}),
      ...(options.teamAssets ? { teamAssets: options.teamAssets } : {}),
      assertModel: options.assertModel ?? (() => undefined),
      ...(workspace
        ? {
            native: {
              workingDirectory: (binding, grant) => ({
                kind: 'local',
                scope: binding.scope,
                cwd: workspace.path,
                workspaceId: workspace.id,
                signal: grant.signal,
                assertCurrent() {
                  grant.assertCurrent('send');
                },
              }),
              async compose() {
                await options.beforeCompose?.();
                return { context: '', toolAllowlist: [] };
              },
            },
          }
        : {}),
    });
    return { ctx, adapter, owner, workspace, close: () => ctx.fiber.dispose() };
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}
