/** Original Cookie/Run/SDK/JSON/attachments/FS; explicit fixture workspace/publication grants. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import LocalFS from '@deepseek-ai/dsh-fs-local';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import * as ToolFs from '@deepseek-ai/dsh-tool-fs';
import { canonicalPayload } from '@zhuma/agent-core';
import { bootRunFiles, toolResponse } from './native-work-session-files-fixture.mjs';
import { openExecutionMemberLease } from '../dist/member-session.js';
import {
  NativeRunLocalToolProducer,
  NATIVE_RUN_LOCAL_TOOL_CONFIG,
  NATIVE_RUN_LOCAL_TOOL_SOURCE_VERSION,
} from '../dist/native-run-local-tools.js';
import { NativeOutputFileByteProducer } from '../dist/native-work-session-output-file-source.js';
import { createNativeOutputFileIssuer } from '../dist/native-work-session-output-file.js';
import { describeNativeOutputFileTool } from '../dist/native-work-session-output-file-tool.js';
import { executionRunCompositionRequest } from '../dist/execution-run-composition.js';

export { describeNativeOutputFileTool, toolResponse };
const hash = (value) => createHash('sha256').update(canonicalPayload(value)).digest('hex');
class OutputFS extends LocalFS {
  reads = 0;
  stats = 0;
  async readBytes(...args) {
    this.reads++;
    await this.beforeRead?.();
    return super.readBytes(...args);
  }
  async stat(...args) {
    this.stats++;
    await this.beforeStat?.(...args);
    return super.stat(...args);
  }
}
export async function bootOutputFiles(
  root,
  {
    first = true,
    publisher = true,
    activate = true,
    resultIntentTool,
    configureResults,
    composeResults,
    extraExpertNode = false,
  } = {},
) {
  const workspaceRoot = join(root, 'work');
  if (first) {
    await mkdir(join(workspaceRoot, 'outputs'), { recursive: true });
    await writeFile(
      join(workspaceRoot, 'outputs', 'result.bin'),
      Buffer.from([0, 255, 254, 128, 1, 42, 0, 31]),
    );
  }
  const lifetime = new AbortController(),
    publishLifetime = new AbortController();
  let host,
    outputIssuer,
    native,
    opened,
    allowed = true;
  const runWorkspace = {
    kind: 'local',
    deviceId: 'fixture-device',
    rootId: 'fixture-root',
    grantId: 'fixture-root-grant',
    generation: 1,
    access: 'read',
  };
  const producers = new Map();
  function producer(binding, grant) {
    let result = producers.get(binding.nativeAgentId);
    if (result) return result;
    const origin = new NativeRunLocalToolProducer(host.ctx, {
      sourceVersion: NATIVE_RUN_LOCAL_TOOL_SOURCE_VERSION,
      signal: lifetime.signal,
      assertCurrent() {
        lifetime.signal.throwIfAborted();
        return undefined;
      },
    });
    const scope = structuredClone(grant.scope);
    result = new NativeOutputFileByteProducer(
      origin,
      {
        scope,
        root: workspaceRoot,
        permissions: { read: true, write: false },
        signal: lifetime.signal,
        assertCurrent() {
          host.issuer.assertGrant(grant, 'send');
          return undefined;
        },
      },
      {
        scope: structuredClone(scope),
        configurationId: binding.selection.configurationId,
        signal: publishLifetime.signal,
        paths: [{ kind: 'directory', path: 'outputs' }],
        assertCurrent() {
          host.issuer.assertGrant(grant, 'send');
          if (!allowed)
            throw Object.assign(Error('publication-denied'), { code: 'publication-denied' });
          return undefined;
        },
      },
    );
    producers.set(binding.nativeAgentId, result);
    return result;
  }
  host = await bootRunFiles(root, {
    first,
    runWorkspace,
    parallelHumanNode: true,
    extraExpertNode,
    ...(resultIntentTool === undefined ? {} : { resultIntentTool }),
    ...(publisher ? { outputFilePublisherTool: describeNativeOutputFileTool() } : {}),
    workingDirectory(binding, grant) {
      return {
        kind: 'local',
        scope: binding.scope,
        cwd: workspaceRoot,
        signal: lifetime.signal,
        assertCurrent() {
          host.issuer.assertGrant(grant, 'send');
          return undefined;
        },
      };
    },
    composeExtra(ctx, binding, grant) {
      const file = publisher
        ? outputIssuer.registerNativeOutputFileTool(ctx, binding, grant)
        : { context: '', toolAllowlist: [] };
      const result = composeResults?.(ctx, binding, grant) ?? { context: '', toolAllowlist: [] };
      return {
        context: [file.context, result.context].filter(Boolean).join('\n'),
        toolAllowlist: [...file.toolAllowlist, ...result.toolAllowlist],
      };
    },
  });
  for (const [plugin, config] of [
    [OutputFS, { cwd: workspaceRoot }],
    [WorkingDirectory, { defaultDirectory: workspaceRoot }],
    [ToolFs, NATIVE_RUN_LOCAL_TOOL_CONFIG],
  ])
    await host.ctx.plugin(plugin, config);
  host.ctx.effect(() => async () => {
    lifetime.abort();
    publishLifetime.abort();
    await Promise.all([...producers.values()].map((p) => p.close()));
  });
  if (first) {
    const input = await host.upload('Accepted source input.');
    await host.submit(input, 'output-source-input');
    await host.ballot('approve', 'output-source-approve');
    opened = await host.begin();
  } else opened = await host.openExisting();
  native = await host.nativeSession();
  if (publisher)
    outputIssuer = createNativeOutputFileIssuer(
      host.ctx,
      native.service,
      host.issuer,
      host.execution,
      producer,
    );
  await configureResults?.({ ...host, native, opened, outputIssuer });
  if (activate) {
    host.adapter.script.push('Ordinary work in progress, no completed artifact.');
    await native.service.send(opened.grant, {
      ...host.firstMessage(),
      requestId: first ? 'output-first' : 'output-reopen',
    });
    await host.ctx.agents.get(native.service.open(opened.grant).binding.nativeAgentId).whenIdle();
  }
  const binding = native.service.open(opened.grant).binding;
  const selectors = new Map();
  const port = host.execution.createRunOutputFiles(host.issuer, {
    signal: lifetime.signal,
    assertCurrent(attachments) {
      assert.ok(attachments);
      lifetime.signal.throwIfAborted();
      return undefined;
    },
    assertPublication(grant, source, fingerprint) {
      const path = selectors.get(fingerprint);
      assert.ok(path);
      assert.equal(source.nativeSessionId, binding.nativeSessionId);
      assert.equal(source.nativeAgentId, binding.nativeAgentId);
      return producer(binding, grant).authorize(grant, source.configurationId, path);
    },
  });
  const request = (callId, mode = 'reserve', path = 'outputs/result.bin', name = 'result.bin') => {
    const source = {
      scope: structuredClone(opened.grant.scope),
      nativeSessionId: binding.nativeSessionId,
      nativeAgentId: binding.nativeAgentId,
      configurationId: binding.selection.configurationId,
      expertVersionId: executionRunCompositionRequest(host.snapshot).expertVersionId,
      toolVersion: 'zhuma-native-output-file@1',
      callId,
    };
    const selectorFingerprint = hash({ path, name });
    selectors.set(selectorFingerprint, path);
    return {
      source,
      selectorFingerprint,
      name,
      mode,
      ...(mode === 'reserve' ? { maximumBytes: 8 } : {}),
    };
  };
  let turn = 0,
    historyCursor = -1;
  const invokeBatch = async (requests) => {
    const calls = requests.map(({ args, callId = `publish-${++turn}` }) => ({ args, callId }));
    host.adapter.script.push(function* () {
      for (let index = 0; index < calls.length; index++) {
        const { args, callId } = calls[index];
        const json = JSON.stringify(args),
          name = 'publish_output_file';
        yield { type: 'block-start', index, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index, id: callId, name, argumentsDelta: json };
        yield {
          type: 'block-end',
          index,
          block: { type: 'tool-call', id: callId, name, arguments: json },
        };
      }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    }, 'Publication returned.');
    await native.service.send(opened.grant, {
      ...host.firstMessage(),
      requestId: randomUUID(),
      text: 'Publish the requested output.',
    });
    await host.ctx.agents.get(binding.nativeAgentId).whenIdle();
    const events = [];
    for (;;) {
      const page = await native.service.history(opened.grant, historyCursor, 20);
      events.push(...page.events);
      historyCursor = page.events.at(-1)?.seq ?? historyCursor;
      if (page.events.length < 20) break;
    }
    return calls.map(({ callId }) => {
      const result = events
        .filter((e) => e.type === 'tool/result' && e.data.message.toolCallId === callId)
        .at(-1);
      assert.ok(result);
      try {
        return JSON.parse(result.data.message.content[0].text);
      } catch {
        return { ok: false, isError: result.data.message.isError };
      }
    });
  };
  const invoke = async (args, callId) => (await invokeBatch([{ args, callId }]))[0];
  const humanUpload = async (content, { signal, data, key = randomUUID() } = {}) => {
    const bytes = Buffer.from(content),
      lease = await openExecutionMemberLease(host.ctx, host.requests.chen);
    try {
      return await host.execution.uploadFile(
        await host.caller('chen'),
        {
          ...host.locate('parallel'),
          spaceId: 'north',
          idempotencyKey: key,
          declare: {
            name: 'human.bin',
            mediaType: 'application/octet-stream',
            byteSize: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
          signal,
          data: data ?? {
            async *[Symbol.asyncIterator]() {
              yield bytes;
            },
          },
        },
        {
          lease,
          assertProjectSpace(projectId, spaceId) {
            const actual = host.directory.spaceForProjectNow(projectId);
            assert.equal(actual.ok, true);
            assert.equal(actual.spaceId, spaceId);
            return undefined;
          },
        },
      );
    } finally {
      lease.release();
    }
  };
  return {
    ...host,
    native,
    opened,
    binding,
    outputIssuer,
    workspaceRoot,
    port,
    request,
    invoke,
    invokeBatch,
    humanUpload,
    producer: producer(binding, opened.grant),
    denyPublication() {
      allowed = false;
    },
    async close() {
      opened.dispose();
      await host.close();
    },
  };
}
