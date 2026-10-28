import assert from 'node:assert/strict';
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { createServer } from 'node:http';
import {
  canonicalPayload,
  REMOTE_RUN_OPERATIONS,
  REMOTE_RUN_PERMIT_HEADER,
  remoteDeviceSigningInput,
  remoteRunRequestSchema,
} from '@zhuma/agent-core';
import { MemberLocalExecutionProtocol } from '../dist/member-local-execution-protocol.js';
import { MemberLocalExecutionSecrets } from '../dist/member-local-execution-secrets.js';
import { freezeExecutionRunComposition } from '../dist/execution-run-composition.js';
import { describeNativeResultTool } from '../dist/native-work-session-result-tool.js';
import { describeAcceptedInputTool } from '../dist/native-work-session-input-tool.js';
import { compositionFacts } from './execution-run-composition-fixture.mjs';

// Actual outgoing HTTP, Ed25519 and original composition decoder. Member/device
// authorization and backend Run state remain a contract, not two product Hosts.
export async function fixture(t, options = {}) {
  const facts = {
    ...compositionFacts({ upstream: options.upstream }),
    resultIntentTool: describeNativeResultTool(),
  };
  if (options.upstream)
    facts.tools = { kind: 'accepted-input-reader', definition: describeAcceptedInputTool() };
  const composition = freezeExecutionRunComposition(facts),
    backendId = randomUUID(),
    driveEpoch = randomUUID(),
    cleanupEpoch = randomUUID(),
    rows = new Map(),
    seen = [];
  const document = options.upstream
    ? {
        actorId: facts.scope.actorId,
        spaceId: facts.scope.spaceId,
        downstream: {
          taskId: facts.scope.taskId,
          planId: facts.scope.planId,
          revision: facts.scope.revision,
          nodeId: facts.scope.nodeId,
        },
        source: {
          taskId: facts.scope.taskId,
          planId: facts.scope.planId,
          revision: facts.scope.revision,
          nodeId: facts.node.handoff.inputRefs[0].sourceNodeId,
        },
        version: {
          id: facts.node.handoff.inputRefs[0].artifactVersionId,
          version: facts.inputs.items[0].version,
        },
        content: {
          text: options.text ?? 'PRIVATE_SOURCE_BODY_NOT_IN_PROMPT',
          links: options.links ?? [],
          files: [],
        },
      }
    : undefined;
  options.mutateDocument?.(document);
  const data = document ? Buffer.from(canonicalPayload(document)) : undefined;
  const inputs = document
    ? [
        {
          slotId: 'remote-slot-1',
          kind: 'text',
          name: 'Accepted contract content',
          sourceNodeId: document.source.nodeId,
          artifactVersionId: document.version.id,
          byteSize: data.length,
          sha256: createHash('sha256').update(data).digest('hex'),
        },
      ]
    : [];
  let key,
    value,
    acceptCalls = 0,
    lost = options.loseAccept === true,
    failStore = false,
    changeScope = false;
  const store = {
    async read(slot) {
      return structuredClone(rows.get(slot));
    },
    async modify(slot, update) {
      if (failStore) throw Error('PRIVATE_PROVIDER_ERROR');
      const next = update(structuredClone(rows.get(slot)));
      rows.set(slot, structuredClone(next));
      return structuredClone(next);
    },
  };
  const methods = Object.fromEntries(
    REMOTE_RUN_OPERATIONS.map((operation) => [operation, `zhuma-proof/${operation}`]),
  );
  const server = createServer(async (req, res) => {
    try {
      let bytes = '';
      for await (const chunk of req) bytes += chunk;
      const envelope = JSON.parse(bytes),
        request = remoteRunRequestSchema.parse(envelope.payload);
      assert.equal(req.url, `/api/${methods[request.operation]}`);
      assert.equal(req.headers.cookie, 'synthetic-original-member');
      const respond = (response) =>
        res.end(
          JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: response }),
        );
      seen.push({ request, permit: req.headers[REMOTE_RUN_PERMIT_HEADER] });
      if (request.operation === 'info') {
        respond({
          ok: true,
          value: {
            protocolVersion: 1,
            backendId,
            actorId: options.actorId ?? 'chen',
            serverTime: Date.now(),
            operations: options.operations ?? REMOTE_RUN_OPERATIONS,
            purposes: ['work'],
          },
        });
        return;
      }
      if (request.operation === 'register-device') {
        key = createPublicKey({
          key: Buffer.from(request.payload.publicKey, 'base64url'),
          type: 'spki',
          format: 'der',
        });
      }
      assert.equal(
        verify(
          null,
          Buffer.from(canonicalPayload(remoteDeviceSigningInput(request))),
          key,
          Buffer.from(request.proof.signature, 'base64url'),
        ),
        true,
      );
      if (request.operation === 'register-device') {
        respond(
          options.registerError
            ? { ok: false, error: { code: 'remote-device-unavailable' } }
            : {
                ok: true,
                value: {
                  deviceId: request.deviceId,
                  actorId: 'chen',
                  keyEpoch: 1,
                  disposition: 'enrolled',
                  serverTime: Date.now(),
                },
              },
        );
      } else if (request.operation === 'accept') {
        acceptCalls++;
        assert.equal(rows.size, 2, 'private device and intent were durable before accept');
        assert.equal(req.headers[REMOTE_RUN_PERMIT_HEADER], undefined);
        const intent = [...rows.values()].find((row) => row.requestId === request.requestId);
        assert(!bytes.includes(intent.drive.secret));
        assert(!bytes.includes(intent.cleanup.secret));
        value ??= {
          scope: { backendId, ...facts.scope },
          deviceId: request.deviceId,
          serverTime: Date.now(),
          authority: 'drive',
          permit: {
            id: request.payload.credentials.drive.id,
            epoch: driveEpoch,
            expiresAt: Date.now() + 60_000,
          },
          cleanup: {
            id: request.payload.credentials.cleanup.id,
            epoch: cleanupEpoch,
            expiresAt: Date.now() + 43_200_000,
          },
          nodeVersion: 1,
          runVersion: 1,
          nextSequence: 1,
          stopRequested: false,
          resources: 'held',
          runStatus: 'requested',
          disposition: 'accepted',
          selection: { ...facts.model, configurationId: composition.configurationId },
          shared: {
            configurationId: composition.configurationId,
            composition,
            context: composition.payload.context,
            handoff: composition.payload.handoff,
            inputs,
          },
        };
        if (lost) {
          lost = false;
          res.destroy();
          return;
        }
        const reply = structuredClone(value);
        options.mutate?.(reply);
        respond({ ok: true, value: reply });
      } else if (['input-list', 'input-read'].includes(request.operation)) {
        const intent = [...rows.values()].find((row) => row.requestId);
        assert.equal(req.headers[REMOTE_RUN_PERMIT_HEADER], intent.drive.secret);
        const inputError =
          typeof options.inputError === 'function' ? options.inputError() : options.inputError;
        if (inputError) return respond({ ok: false, error: { code: inputError } });
        if (request.operation === 'input-list') {
          const listed = structuredClone(inputs);
          options.mutateCatalog?.(listed);
          respond({ ok: true, value: { scope: value.scope, items: listed } });
        } else {
          assert.equal(request.payload.slotId, inputs[0].slotId);
          const { offset, maximumBytes } = request.payload;
          const bytes = data.subarray(
            offset,
            offset + Math.min(maximumBytes, options.chunkBytes ?? maximumBytes),
          );
          const page = {
            scope: value.scope,
            slotId: inputs[0].slotId,
            offset,
            byteSize: bytes.length,
            totalBytes: data.length,
            sha256: inputs[0].sha256,
            base64: bytes.toString('base64'),
            eof: offset + bytes.length === data.length,
          };
          options.mutatePage?.(page);
          respond({ ok: true, value: page });
        }
      } else if (request.operation === 'reconcile') {
        const intent = [...rows.values()].find(
          (row) => row.requestId === request.payload.acceptRequestId,
        );
        assert(intent);
        assert.equal(req.headers[REMOTE_RUN_PERMIT_HEADER], intent.drive.secret);
        const { disposition, ...reconciled } = structuredClone(value);
        reconciled.serverTime = Date.now();
        reconciled.permit.expiresAt = Date.now() + 60_000;
        reconciled.authority =
          value.result && !value.stopRequested ? 'commit-only' : 'recovery-required';
        Object.assign(value, reconciled);
        respond({ ok: true, value: reconciled });
      } else if (
        ['status', 'renew', 'event', 'submit-result', 'cleanup'].includes(request.operation)
      ) {
        const intent = [...rows.values()].find((row) => row.requestId),
          cleanup = request.operation === 'cleanup';
        assert.equal(
          req.headers[REMOTE_RUN_PERMIT_HEADER],
          cleanup ? intent.cleanup.secret : intent.drive.secret,
        );
        assert.equal(request.payload.permit.id, cleanup ? intent.cleanup.id : intent.drive.id);
        const {
          disposition: _disposition,
          selection: _selection,
          shared: _shared,
          ...view
        } = value;
        if (request.operation === 'event') {
          assert.equal(request.payload.event.sequence, value.nextSequence);
          value.nextSequence++;
          value.runVersion++;
          if (request.payload.event.kind === 'accepted') value.runStatus = 'running';
          if (request.payload.event.kind === 'completed') {
            value.runStatus = 'completed';
            value.resources = 'settled';
            value.authority = 'commit-only';
            value.result = request.payload.event.result;
          }
          const { disposition, selection, shared, ...changed } = value;
          respond({ ok: true, value: { ...changed, disposition: 'applied' } });
          return;
        }
        if (request.operation === 'submit-result') {
          if (options.submitFailures > 0) {
            options.submitFailures--;
            respond({ ok: false, error: { code: 'remote-unavailable' } });
            return;
          }
          assert.deepEqual(request.payload.result, value.result);
          value.receipt = {
            requestId: value.result.requestId,
            digest: value.result.digest,
            artifactDigest: value.result.artifactDigest,
            artifactVersionId: 'contract-artifact-version',
          };
          respond({
            ok: true,
            value: { scope: value.scope, disposition: 'committed', receipt: value.receipt },
          });
          return;
        }
        if (cleanup && request.payload.observation.kind === 'drained') {
          view.resources = 'settled';
          view.authority = 'cleanup-only';
          if (view.runStatus !== 'completed') view.runStatus = 'cancelled';
          view.nextSequence++;
          Object.assign(value, view);
        }
        if (changeScope) view.scope = { ...view.scope, runId: 'other-run' };
        respond({
          ok: true,
          value: cleanup ? { ...view, disposition: 'applied' } : view,
        });
      } else throw Error('Unexpected contract operation');
    } catch {
      res.destroy();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const protocolOptions = {
    origin: `http://127.0.0.1:${server.address().port}`,
    methods,
    expectedActorId: 'chen',
    authentication: async (signal) => {
      await options.beforeAuthentication?.(signal);
      return { cookie: 'synthetic-original-member' };
    },
    secrets: new MemberLocalExecutionSecrets(store),
  };
  const input = {
    target: {
      spaceId: facts.scope.spaceId,
      taskId: facts.scope.taskId,
      planId: facts.scope.planId,
      revision: facts.scope.revision,
      nodeId: facts.scope.nodeId,
    },
    expectedNodeVersion: 1,
    expectedRunVersion: 0,
    purpose: 'work',
    mode: 'begin',
    model: facts.model,
    workspace: { kind: 'text-only' },
    executor: facts.executor,
    capabilities: {
      resultIntent: 'zhuma-native-result-intent@1',
      localTools: [],
      ...(options.upstream ? { acceptedInput: '1' } : {}),
    },
  };
  return {
    rows,
    store,
    seen,
    composition,
    value: () => structuredClone(value),
    stop: () => {
      value.stopRequested = true;
      value.authority = 'cleanup-only';
    },
    protocolOptions,
    input,
    acceptCalls: () => acceptCalls,
    failStore: () => {
      failStore = true;
    },
    changeScope: () => {
      changeScope = true;
    },
    open: () => MemberLocalExecutionProtocol.open(protocolOptions),
  };
}
