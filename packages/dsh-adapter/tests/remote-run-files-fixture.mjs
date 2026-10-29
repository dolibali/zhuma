/** Real Service, JSON ledger, Ed25519 proofs and official local attachment IO.
 * Member leases and native SDK call/cut reports are contracts, not a two-Host/model acceptance. */
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalPayload,
  remoteDeviceSigningInput,
  remoteResultDigestInput,
} from '@zhuma/agent-core';
import { open } from './execution-service-run-fixture.mjs';
import { currentExecutionRun } from '../dist/execution-run-state.js';
import { nativePublicationManifestDigest } from '../dist/native-work-session-result-publications-source.js';
import { nativeManifestResultDigest } from '../dist/execution-native-result-delivery.js';

export const hash = (value) => createHash('sha256').update(canonicalPayload(value)).digest('hex');
export const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const ok = (result) => {
  assert.equal(result.ok, true, result.ok ? '' : result.error.code);
  return result.value;
};
export const no = (result, code) => {
  assert.equal(result.ok, false);
  if (code) assert.equal(result.error.code, code);
};
export const deferred = () => Promise.withResolvers();
const credential = () => {
  const bytes = randomBytes(32);
  return { raw: bytes.toString('base64url'), public: { id: randomUUID(), sha256: sha(bytes) } };
};

export async function fileHost(
  t,
  {
    expert = false,
    enabled = true,
    seed = true,
    root: existingRoot,
    identity,
    expertNode,
    workbench,
    beforeRemoteEnable,
    remoteOptions,
  } = {},
) {
  const root = existingRoot ?? (await mkdtemp(join(tmpdir(), 'zhuma-remote-files-')));
  const ctx = new Context();
  const fiber = ctx.plugin(AttachmentLocal, { dshHome: join(root, 'attachment-home') });
  await fiber;
  const attachments = ctx.attachments;
  const counts = { saved: 0, read: 0 };
  const controls = {};
  const save = attachments.saveFileStream.bind(attachments),
    read = attachments.readFileStream.bind(attachments);
  attachments.saveFileStream = async (...args) => {
    counts.saved++;
    return save(...args);
  };
  attachments.readFileStream = (...args) => {
    counts.read++;
    return read(...args);
  };
  const h = await open(join(root, 'service'), {
    attachments,
    ...(workbench ? { workbench } : {}),
    expertNode: expertNode ?? (expert ? 'produce' : undefined),
    seed,
  });
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await h.close();
      await fiber.dispose();
    }
  };
  t.after(async () => {
    controls.drain?.resolve();
    controls.input?.resolve();
    await close();
    if (!existingRoot) await rm(root, { recursive: true, force: true });
  });
  h.request.headers.cookie = `zhuma-member=${randomUUID()}.${Date.now() + 1000000}.CONTRACT`;
  const keys = identity?.keys ?? generateKeyPairSync('ed25519');
  const deviceId = identity?.deviceId ?? randomUUID(),
    drive = identity?.drive ?? credential(),
    cleanup = identity?.cleanup ?? credential();
  try {
    await beforeRemoteEnable?.(h);
    await h.service.enableRemoteRuns({
      ...(enabled ? { fileUploads: true } : {}),
      ...remoteOptions,
    });
  } catch (error) {
    await close();
    throw error;
  }
  let backendId;
  const envelope = (operation, payload, requestId = randomUUID()) => ({
    protocolVersion: 1,
    operation,
    requestId,
    ...(operation === 'info' ? {} : { backendId }),
    ...(['info', 'stop'].includes(operation)
      ? {}
      : {
          deviceId,
          proof: { issuedAt: Date.now(), nonce: randomUUID(), signature: 'A'.repeat(86) },
        }),
    payload,
  });
  const signBody = (body) => {
    if ('proof' in body)
      body.proof.signature = sign(
        null,
        Buffer.from(canonicalPayload(remoteDeviceSigningInput(body))),
        keys.privateKey,
      ).toString('base64url');
    return body;
  };
  const send = (body, { secret = drive.raw, request = h.request, upload } = {}) => {
    signBody(body);
    return h.service.remoteRun(request, body, secret, upload);
  };
  const info = ok(await send(envelope('info', {})));
  backendId = info.backendId;
  if (!identity)
    ok(
      await send(
        envelope('register-device', {
          publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
        }),
      ),
    );
  let view;
  const openScope = async (scope) => {
    view = ok(await send(envelope('status', { scope, permit: drive.public })));
    return view;
  };
  const recover = async (scope) => {
    view = ok(await send(envelope('reconcile', { scope, permit: drive.public, lastSequence: 0 })));
    return view;
  };
  const accept = (patch = {}, nodeId = 'produce') =>
    envelope('accept', {
      target: { spaceId: 'north', ...h.locate(nodeId) },
      expectedNodeVersion: h.read(nodeId).command.version,
      expectedRunVersion: h.read(nodeId).nativeExecution?.version ?? 0,
      purpose: 'work',
      mode: 'begin',
      model: { provider: 'contract', model: 'contract', maxTokens: 1000 },
      workspace: {
        kind: 'local',
        rootId: 'opaque-local-root',
        grantId: 'opaque-private-grant',
        generation: 1,
        access: 'read',
      },
      executor:
        h.read(nodeId).handoff.assignee.kind === 'expert'
          ? { kind: 'plan-expert', ref: h.read(nodeId).handoff.expertRef }
          : { kind: 'builtin' },
      capabilities: {
        resultIntent: 'zhuma-native-result-intent@2',
        outputFile: 'zhuma-native-output-file@1',
        localTools: [],
      },
      credentials: { drive: drive.public, cleanup: cleanup.public },
      ...patch,
    });
  const begin = async (patch = {}, nodeId = 'produce') => {
    view = ok(await send(accept(patch, nodeId)));
    view = ok(
      await send(
        scopeBody('event', {
          event: { kind: 'received', sequence: 1, nativeSessionId: 'file-native' },
        }),
      ),
    );
    view = ok(
      await send(
        scopeBody('event', {
          event: {
            kind: 'accepted',
            sequence: 2,
            nativeSessionId: 'file-native',
            executorRunId: 'file-agent',
          },
        }),
      ),
    );
    return view;
  };
  const scopeBody = (operation, fields = {}, requestId) =>
    envelope(operation, { scope: view.scope, permit: drive.public, ...fields }, requestId);
  const selector = (callId = 'publish') => {
    const { backendId: _backend, ...scope } = view.scope;
    const source = {
      scope,
      nativeSessionId: 'file-native',
      nativeAgentId: 'file-agent',
      configurationId: currentExecutionRun(h.read()).selection.configurationId,
      expertVersionId: currentExecutionRun(h.read()).attempt.expertVersionId,
      toolVersion: 'zhuma-native-output-file@1',
      callId,
    };
    return {
      source,
      selectorFingerprint: hash({ path: `outputs/${callId}.txt`, name: 'result.txt' }),
      idempotencyKey: `native-output_${hash(source)}`,
      name: 'result.txt',
    };
  };
  const reserve = async (bytes, callId) => {
    const selected = selector(callId);
    return {
      selected,
      value: ok(
        await send(
          scopeBody('publish-file', {
            ...selected,
            mode: 'reserve',
            maximumBytes: bytes.byteLength,
          }),
        ),
      ),
    };
  };
  const publish = async (reserved, bytes, upload) =>
    send(
      scopeBody('publish-file', {
        mode: 'publish',
        reservationId: reserved.reservationId,
        declare: {
          name: 'result.txt',
          mediaType: 'text/plain',
          byteSize: bytes.byteLength,
          sha256: sha(bytes),
        },
      }),
      {
        upload: upload ?? {
          signal: new AbortController().signal,
          data: (async function* () {
            yield bytes;
          })(),
        },
      },
    );
  const result = (returned, selected, text) => {
    const evidence = {
      publicationId: returned.uploadId,
      source: selected.source,
      callSeq: 1,
      resultSeq: 2,
      selectorFingerprint: selected.selectorFingerprint,
      name: 'result.txt',
      mediaType: 'text/plain',
      byteSize: returned.record.byteSize,
      sha256: returned.record.sha256,
    };
    const manifestDigest = nativePublicationManifestDigest([{ evidence, record: returned.record }]);
    const source = {
      scope: selected.source.scope,
      nativeSessionId: 'file-native',
      nativeAgentId: 'file-agent',
      configurationId: selected.source.configurationId,
      expertVersionId: selected.source.expertVersionId,
      toolVersion: 'zhuma-native-result-intent@2',
      intentId: 'completion',
      callId: 'complete',
      cut: { callSeq: 3, resultSeq: 4, turnEndSeq: 5, asOfSeq: 5 },
      manifestDigest,
    };
    const draft = { links: [], files: [returned.file], ...(text === undefined ? {} : { text }) };
    return {
      draft,
      declaration: {
        requestId: randomUUID(),
        source,
        publications: [evidence],
        digest: nativeManifestResultDigest(draft, manifestDigest, [evidence]),
        artifactDigest: hash(remoteResultDigestInput(draft)),
      },
    };
  };
  const complete = async (value) => {
    view = ok(
      await send(
        scopeBody('event', {
          event: {
            kind: 'completed',
            sequence: view.nextSequence,
            idle: true,
            flushed: true,
            resourcesSettled: true,
            result: value.declaration,
          },
        }),
      ),
    );
    return view;
  };
  const submit = (value) =>
    send(
      scopeBody(
        'submit-result',
        { expectedNodeVersion: view.nodeVersion, result: value.declaration, draft: value.draft },
        value.declaration.requestId,
      ),
    );
  return {
    ...h,
    root,
    ctx,
    attachments,
    counts,
    controls,
    close,
    send,
    signBody,
    envelope,
    scopeBody,
    begin,
    accept,
    selector,
    reserve,
    publish,
    result,
    complete,
    submit,
    drive,
    cleanup,
    deviceId,
    identity: { keys, deviceId, drive, cleanup },
    openScope,
    recover,
    get view() {
      return view;
    },
  };
}
