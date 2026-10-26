/** Real Cookie/identity/directory/execution/SDK/JSON; fixture-selected model/tool configuration. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Context, symbols } from '@deepseek-ai/cordis';
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
import Credentials from '@deepseek-ai/dsh-credentials-local';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import * as Connection from '@deepseek-ai/dsh-client-connection';
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access';
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local';
import { applyWorkbenchCommand, canonicalPayload } from '@zhuma/agent-core';
import { fixture } from '../../../tests/fixtures/workbench.mjs';
import { applyIdentity, hashPassword } from '../dist/identity-session.js';
import {
  configureDeploymentMode,
  openExecutionMemberLease,
  resolveMember,
} from '../dist/member-session.js';
import { applySpaceDirectory, spaceDirectoryFor } from '../dist/space-directory.js';
import { openWorkbench, workbenchDomainSpec } from '../dist/workbench-plugin.js';
import { apply as applyExecution } from '../dist/execution-plugin.js';
import {
  freezeExecutionRunComposition,
  executionRunCompositionRequest,
} from '../dist/execution-run-composition.js';
import {
  describeAcceptedInputTool,
  registerNativeAcceptedInputTool,
} from '../dist/native-work-session-input-tool.js';
import {
  describeNativeAcceptedFileTool,
  registerNativeAcceptedFileTool,
} from '../dist/native-work-session-files-tool.js';
import { openNativeWorkSessions } from '../dist/native-work-session-storage.js';
import { ScriptedAdapter } from './native-work-session-fixture.mjs';

export { ScriptedAdapter, describeNativeAcceptedFileTool };
export { allHistory } from './native-work-session-fixture.mjs';
export { toolResponse } from './native-work-session-input-fixture.mjs';
const original = (value) => value && (Reflect.get(value, symbols.original) ?? value);
export function checked(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}
export async function bootRunFiles(
  root,
  {
    first = true,
    script = [],
    tools,
    acceptedFiles = false,
    resultIntentTool,
    composeExtra,
    configureNative,
    runWorkspace = { kind: 'text-only' },
    workingDirectory = () => ({ kind: 'text-only' }),
    outputFilePublisherTool,
    parallelHumanNode = false,
    extraExpertNode = false,
  } = {},
) {
  const ctx = new Context();
  const adapter = new ScriptedAdapter(script);
  const password = 'synthetic-run-file-fixture-password';
  const lifetime = new AbortController();
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
      [Credentials, { path: join(root, 'credentials.yaml'), watch: false }],
      [WebServer, { host: '127.0.0.1', port: 0 }],
      [Connection],
      [RemoteAccess],
      [LocalAttachmentStore, { dshHome: root }],
    ])
      await ctx.plugin(plugin, config);
    ctx.llm.registerAdapter(['contract'], adapter);
    configureDeploymentMode(ctx, 'multi-member');
    await applySpaceDirectory(
      ctx,
      first
        ? {
            spaces: [{ id: 'north', kind: 'team', name: 'File fixture' }],
            memberships: ['chen', 'lin', 'outside'].map((accountId) => ({
              spaceId: 'north',
              accountId,
            })),
            projectSpaces: [{ projectId: 'project', spaceId: 'north' }],
          }
        : undefined,
    );
    const directory = spaceDirectoryFor(ctx);
    await applyIdentity(
      ctx,
      first
        ? {
            accounts: ['chen', 'lin', 'outside'].map((id) => ({
              id,
              passwordHash: hashPassword(password),
            })),
          }
        : undefined,
      {
        currentDirectoryBinding() {
          return {
            directory,
            signal: directory.signal,
            isCurrent: () => !directory.signal.aborted && spaceDirectoryFor(ctx) === directory,
          };
        },
      },
    );
    if (first) {
      const data = fixture();
      data.state.participants.push({
        ...data.state.participants[0],
        id: 'lin',
        name: 'Lin reviewer',
      });
      data.state.participants.find((p) => p.id === 'qa').instructions =
        'Read only selected accepted fixed input files.';
      const state = applyWorkbenchCommand(data.state, {
        type: 'save-task',
        task: {
          ...data.task,
          participantIds: ['chen', 'lin', 'qa'],
          status: 'ready',
          workflows: [
            {
              ...data.task.workflows[0],
              nodes: [
                {
                  ...data.node,
                  id: 'source',
                  assigneeId: 'chen',
                  reviewerIds: ['lin'],
                  reviewRequired: true,
                  skillIds: [],
                },
                {
                  ...data.node,
                  id: 'expert',
                  assigneeId: 'qa',
                  reviewerIds: [],
                  reviewRequired: false,
                  dependsOn: ['source'],
                  skillIds: [],
                },
                ...(extraExpertNode
                  ? [
                      {
                        ...data.node,
                        id: 'expert-other',
                        assigneeId: 'qa',
                        reviewerIds: [],
                        reviewRequired: false,
                        dependsOn: ['source'],
                        skillIds: [],
                      },
                    ]
                  : []),
                ...(parallelHumanNode
                  ? [
                      {
                        ...data.node,
                        id: 'parallel',
                        assigneeId: 'chen',
                        reviewerIds: [],
                        reviewRequired: false,
                        dependsOn: [],
                        skillIds: [],
                      },
                    ]
                  : []),
              ],
            },
          ],
        },
      });
      const domain = await ctx.storageDomain.open(workbenchDomainSpec);
      await domain.global.set(state);
      await domain.close();
    }
    const workbench = await openWorkbench(ctx);
    let execution;
    await applyExecution(ctx, {
      readWorkbench: workbench.readWorkbench,
      projectSpaces: directory,
      publishRunService(service) {
        execution = service;
        return () => {};
      },
    });
    ctx.webServer.register({
      kind: 'exact',
      path: '/',
      handler(req, res) {
        if (ctx.connection.authorizeIndex(req, res)) res.writeHead(200).end('File fixture');
      },
    });
    const base = `http://127.0.0.1:${ctx.webServer.port}`;
    const handshake = await fetch(ctx.connection.authenticatedUrl(base), { redirect: 'manual' });
    const owner = handshake.headers.getSetCookie()[0].split(';')[0];
    const requests = {};
    for (const accountId of ['chen', 'lin', 'outside']) {
      const response = await fetch(base + '/zhuma-id/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: owner },
        body: JSON.stringify({ accountId, password }),
      });
      assert.equal(response.status, 200);
      requests[accountId] = {
        headers: {
          host: new URL(base).host,
          origin: base,
          cookie: `${owner}; ${response.headers.getSetCookie()[0].split(';')[0]}`,
        },
      };
    }
    const caller = async (id) => ({ member: await resolveMember(ctx, requests[id]) });
    const project = (projectId, spaceId) => {
      const current = spaceDirectoryFor(ctx);
      const found = current.spaceForProjectNow(projectId);
      assert.equal(current, directory);
      if (!found.ok || found.spaceId !== spaceId) throw Error('current project mapping refused');
      return undefined;
    };
    let selected;
    const configured = new Map();
    const issuer = execution.installRunHost({
      signal: lifetime.signal,
      memberLease: (request) => openExecutionMemberLease(ctx, request),
      assertProjectSpace: project,
      assertConfiguration(member, space, _node, request) {
        assert.equal(member, 'chen');
        assert.equal(space, 'north');
        const expected = extraExpertNode
          ? configured.get(request.composition.configurationId)
          : selected;
        assert.ok(expected);
        assert.equal(canonicalPayload(request.composition), canonicalPayload(expected));
        if (extraExpertNode)
          for (const key of ['taskId', 'planId', 'revision', 'nodeId'])
            assert.equal(expected.payload.scope[key], _node[key]);
        assert.equal(request.selection.provider, 'contract');
        assert.equal(request.selection.model, 'contract-model');
        return undefined;
      },
      assertWorkspace(member, space, workspace, access, configurationId) {
        assert.equal(member, 'chen');
        assert.equal(space, 'north');
        assert.deepEqual(workspace, runWorkspace);
        assert.equal(access, runWorkspace.kind === 'local' ? runWorkspace.access : 'read');
        if (extraExpertNode) assert.ok(configured.has(configurationId));
        else assert.equal(configurationId, selected.configurationId);
        return undefined;
      },
      onChange(recheck) {
        return ctx.on('domain/changed', recheck, { global: true });
      },
    });
    const reader = execution.createRunAcceptedFiles(issuer, {
      signal: lifetime.signal,
      assertCurrent(attachments) {
        if (lifetime.signal.aborted || original(ctx.get('attachments')) !== original(attachments))
          throw Error('actual attachment producer changed');
        return undefined;
      },
    });
    let native;
    const nativeSession = async () => {
      if (native) return native;
      native = await openNativeWorkSessions(ctx, {
        workingDirectory,
        compose(agentCtx, binding, grant) {
          issuer.assertGrant(grant, 'send');
          const snapshot = execution.readRunComposition(binding.scope);
          assert.equal(canonicalPayload(binding.scope), canonicalPayload(snapshot.payload.scope));
          const allowlist = [];
          if (snapshot.payload.toolAllowlist.includes('read_accepted_input')) {
            const registered = registerNativeAcceptedInputTool(
              agentCtx,
              binding,
              grant,
              native.service,
              {
                catalog: {
                  scope: grant.scope,
                  inputs: snapshot.payload.inputs.map((input) => ({ input, required: true })),
                },
                async resolveCurrentCaller(signal) {
                  signal.throwIfAborted();
                  issuer.assertGrant(grant, 'send');
                  const result = await caller('chen');
                  issuer.assertGrant(grant, 'send');
                  return result;
                },
                reader: execution,
              },
            );
            allowlist.push(...registered.toolAllowlist);
          }
          if (snapshot.payload.toolAllowlist.includes('read_accepted_file')) {
            const registered = registerNativeAcceptedFileTool(
              agentCtx,
              binding,
              grant,
              native.service,
              issuer,
              reader,
            );
            allowlist.push(...registered.toolAllowlist);
          }
          if (composeExtra)
            allowlist.push(...composeExtra(agentCtx, binding, grant, native).toolAllowlist);
          assert.deepEqual(allowlist, snapshot.payload.toolAllowlist);
          configureNative?.(agentCtx, binding, grant);
          return { context: snapshot.payload.context, toolAllowlist: allowlist };
        },
      });
      return native;
    };
    const plan = workbench.readWorkbench().appliedPlans.at(-1);
    const locate = (nodeId) => ({
      taskId: 'task',
      planId: plan.id,
      revision: plan.revision,
      nodeId,
    });
    const row = (nodeId) => execution.readRunNode(locate(nodeId));
    if (first)
      checked(
        await execution.startPlan(await caller('chen'), {
          taskId: 'task',
          planId: plan.id,
          revision: plan.revision,
          spaceId: 'north',
          idempotencyKey: 'start-files',
        }),
      );
    const upload = async (text, name = 'fixed.txt', mediaType = 'text/plain') => {
      const bytes = Buffer.from(text);
      const value = checked(
        await execution.uploadFile(
          await caller('chen'),
          {
            ...locate('source'),
            spaceId: 'north',
            idempotencyKey: randomUUID(),
            declare: {
              name,
              mediaType,
              byteSize: bytes.length,
              sha256: createHash('sha256').update(bytes).digest('hex'),
            },
            data: {
              async *[Symbol.asyncIterator]() {
                yield bytes;
              },
            },
          },
          {
            lease: await openExecutionMemberLease(ctx, requests.chen),
            assertProjectSpace: project,
          },
        ),
      );
      return { ...value, originalBytes: bytes };
    };
    const submit = async (file, key) =>
      checked(
        await execution.submit(
          await caller('chen'),
          {
            ...locate('source'),
            expectedVersion: row('source').command.version,
            idempotencyKey: key,
            files: [file.reference],
          },
          async () => ({
            lease: await openExecutionMemberLease(ctx, requests.chen),
            assertProjectSpace: project,
          }),
        ),
      );
    const ballot = async (choice, key) =>
      checked(
        await execution.ballot(await caller('lin'), {
          ...locate('source'),
          expectedVersion: row('source').command.version,
          idempotencyKey: key,
          roundId: row('source').currentRoundId,
          artifactVersionId: row('source').artifactVersions.at(-1).id,
          action: choice,
          ...(choice === 'request-changes' ? { comment: 'Please revise the file.' } : {}),
        }),
      );
    const begin = async (
      toolChoice = tools ?? {
        kind: 'accepted-input-reader',
        definition: describeAcceptedInputTool(),
      },
      options = {},
    ) => {
      const nodeId = options.nodeId ?? 'expert',
        runId = options.runId ?? 'file-run',
        segmentId = options.segmentId ?? 'file-segment';
      const intentTool = options.resultIntentTool ?? resultIntentTool;
      const input = checked(
        await execution.readRunCompositionInputs(requests.chen, {
          ...locate(nodeId),
          spaceId: 'north',
        }),
      );
      selected = freezeExecutionRunComposition({
        workbench: workbench.readWorkbench(),
        node: row(nodeId),
        scope: {
          actorId: 'chen',
          spaceId: 'north',
          ...locate(nodeId),
          runId,
          generation: 1,
          segmentId,
        },
        model: { provider: 'contract', model: 'contract-model', maxTokens: 1000 },
        executor: { kind: 'plan-expert', ref: { id: 'qa', version: plan.id } },
        inputs: input,
        tools: toolChoice,
        ...(acceptedFiles ? { acceptedFileReader: describeNativeAcceptedFileTool() } : {}),
        ...(intentTool === undefined ? {} : { resultIntentTool: intentTool }),
        ...(outputFilePublisherTool ? { outputFilePublisherTool } : {}),
      });
      configured.set(selected.configurationId, selected);
      const projected = executionRunCompositionRequest(selected);
      checked(
        await execution.startRun(requests.chen, {
          ...locate(nodeId),
          spaceId: 'north',
          requestId: `${runId}-start`,
          mode: 'begin',
          expectedNodeVersion: row(nodeId).command.version,
          expectedRunVersion: 0,
          newRunId: runId,
          newSegmentId: segmentId,
          workspace: runWorkspace,
          selection: projected.selection,
          contextRefs: projected.contextRefs,
          inputFingerprint: projected.inputFingerprint,
          expertVersionId: projected.expertVersionId,
          composition: selected,
        }),
      );
      return issuer.open(requests.chen, { ...locate(nodeId), runId }, 'drive');
    };
    ctx.effect(() => () => lifetime.abort());
    return {
      ctx,
      root,
      adapter,
      directory,
      workbench,
      execution,
      issuer,
      reader,
      nativeSession,
      requests,
      caller,
      locate,
      row,
      upload,
      submit,
      ballot,
      begin,
      openExisting() {
        selected = execution.readRunComposition({
          ...locate('expert'),
          runId: row('expert').nativeExecution.currentRunId,
        });
        configured.set(selected.configurationId, selected);
        return issuer.open(
          requests.chen,
          { ...locate('expert'), runId: selected.payload.scope.runId },
          'drive',
        );
      },
      firstMessage(snapshot = selected) {
        const projected = executionRunCompositionRequest(snapshot);
        return {
          requestId: 'file-run-start',
          text: projected.firstMessage.text,
          mode: projected.firstMessage.mode,
          selection: projected.selection,
        };
      },
      async stop() {
        const node = row('expert');
        return checked(
          await execution.stopRun(requests.chen, {
            ...locate('expert'),
            spaceId: 'north',
            requestId: randomUUID(),
            expectedNodeVersion: node.command.version,
            expectedRunVersion: node.nativeExecution.version,
            runId: selected.payload.scope.runId,
            generation: selected.payload.scope.generation,
            segmentId: selected.payload.scope.segmentId,
          }),
        );
      },
      async revoke() {
        const response = await fetch(base + '/zhuma-id/logout', {
          method: 'POST',
          headers: { ...requests.chen.headers, 'content-type': 'application/json' },
          body: '{}',
        });
        assert.equal(response.status, 200);
      },
      get snapshot() {
        return selected;
      },
      close: () => ctx.fiber.dispose(),
    };
  } catch (error) {
    lifetime.abort();
    await ctx.fiber.dispose();
    throw error;
  }
}
