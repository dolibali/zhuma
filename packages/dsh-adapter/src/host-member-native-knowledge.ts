import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  canonicalPayload,
  KnowledgeLibrariesValueSchema,
  type KnowledgeLibrary,
} from '@zhuma/agent-core';
import type { HostSharedBackend } from './host-shared-backend.js';
import { ExecutionRunError } from './execution-run-state.js';
import type {
  NativeSessionBinding,
  NativeWorkGrant,
  NativeWorkScope,
} from './native-work-session-contract.js';
import type { MemberLocalAcceptedRun } from './member-local-execution-protocol.js';
import { nativeScopeKey } from './native-work-session-record.js';
import { createHostMemberKnowledgePort } from './host-member-knowledge-port.js';
import { readExecutionRunComposition } from './execution-run-composition.js';

export const memberNativeKnowledgeChoiceSchema = z.strictObject({
  libraryId: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[\w-]+$/u),
  allowDrafts: z.boolean().default(false),
});
type Choice = z.infer<typeof memberNativeKnowledgeChoiceSchema>;
type FrozenChoice = {
  readonly library: KnowledgeLibrary;
  readonly choice: Choice;
  readonly fingerprint: string;
};

/** Private per-Run UI consent only. Library existence/access is always read
 * from the original member service, and every tool call repeats that service's gates. */
export function createHostMemberNativeKnowledge(options: {
  backend: HostSharedBackend;
  connectionId: string;
  actorId: string;
  lifetime: AbortSignal;
  current(signal: AbortSignal): Promise<void>;
  admit(signal: AbortSignal): void;
}) {
  const prepared = new Map<string, FrozenChoice>();
  const accepted = new Map<string, FrozenChoice>();
  let fenced = false;
  const current = async (signal: AbortSignal) => {
    if (fenced) throw new ExecutionRunError('run-authority-denied');
    await options.current(signal);
    if (fenced) throw new ExecutionRunError('run-authority-denied');
  };
  async function libraries(spaceId: string, signal: AbortSignal) {
    await current(signal);
    const rpcId = randomUUID();
    const response = await options.backend.request(
      {
        connectionId: options.connectionId,
        operation: 'knowledge.libraries',
        rpcId,
        payload: { spaceId },
      },
      signal,
    );
    const envelope = z
      .object({
        type: z.literal('server-response'),
        rpcId: z.literal(rpcId),
        result: z.object({ ok: z.literal(true), value: KnowledgeLibrariesValueSchema }),
      })
      .parse(response.body);
    const value = envelope.result.value;
    if (
      value.actorId !== options.actorId ||
      value.spaceId !== spaceId ||
      value.libraries.some((library) => library.spaceId !== spaceId)
    )
      throw new ExecutionRunError('run-scope-mismatch');
    await current(signal);
    return value.libraries;
  }
  return {
    libraries,
    async workflowChoice(spaceId: string, signal: AbortSignal): Promise<Choice> {
      const source = await libraries(spaceId, signal);
      if (source.length !== 1 || source[0]!.id !== spaceId)
        throw new ExecutionRunError('run-authority-unavailable');
      // Automatic work may read the original published library, never inherit
      // a manual Run's consent to propose drafts.
      return { libraryId: source[0]!.id, allowDrafts: false };
    },
    async prepare(
      requestId: string,
      spaceId: string,
      raw: Choice | undefined,
      signal: AbortSignal,
    ) {
      if (!raw) {
        if (prepared.has(requestId)) throw new ExecutionRunError('run-scope-mismatch');
        return undefined;
      }
      const choice = memberNativeKnowledgeChoiceSchema.parse(raw);
      const source = await libraries(spaceId, signal);
      const library = source.find((item) => item.id === choice.libraryId);
      if (!library) throw new ExecutionRunError('run-authority-denied');
      const fingerprint = canonicalPayload({ spaceId, choice });
      const previous = prepared.get(requestId);
      if (previous && previous.fingerprint !== fingerprint)
        throw new ExecutionRunError('run-scope-mismatch');
      if (!previous) {
        if (prepared.size >= 256) throw new ExecutionRunError('run-capacity');
        prepared.set(
          requestId,
          Object.freeze({
            library: Object.freeze(structuredClone(library)),
            choice: Object.freeze(choice),
            fingerprint,
          }),
        );
      }
      return choice;
    },
    bind(requestId: string, run: MemberLocalAcceptedRun) {
      const value = prepared.get(requestId);
      const { backendId: _backendId, ...scope } = run.value.scope;
      const composition = readExecutionRunComposition(run.composition);
      const project =
        composition.schemaVersion === 2 ? composition.payload.projectKnowledge : undefined;
      if (canonicalPayload(composition.payload.scope) !== canonicalPayload(scope))
        throw new ExecutionRunError('run-scope-mismatch');
      if (
        project &&
        (project.spaceId !== scope.spaceId ||
          project.projectId !== composition.payload.plan.projectId ||
          project.links.some(
            ({ reference }) =>
              reference.spaceId !== scope.spaceId ||
              reference.libraryId !== (value?.library.id ?? scope.spaceId),
          ) ||
          (project.links.some(({ required }) => required) && !value))
      )
        throw new ExecutionRunError('run-scope-mismatch');
      if (!value) return;
      if (scope.spaceId !== value.library.spaceId || scope.actorId !== options.actorId)
        throw new ExecutionRunError('run-scope-mismatch');
      if (composition.schemaVersion !== 2 || !composition.payload.knowledgeTool)
        throw new ExecutionRunError('run-authority-unavailable');
      const key = nativeScopeKey(scope);
      if (accepted.has(key) && accepted.get(key) !== value)
        throw new ExecutionRunError('run-scope-mismatch');
      accepted.set(key, value);
    },
    selection(scope: NativeWorkScope) {
      return accepted.get(nativeScopeKey(scope))?.choice;
    },
    create(binding: NativeSessionBinding, grant: NativeWorkGrant) {
      options.admit(options.lifetime);
      const key = nativeScopeKey(binding.scope),
        value = accepted.get(key);
      if (fenced || !value || canonicalPayload(binding.scope) !== canonicalPayload(grant.scope))
        throw new ExecutionRunError('run-authority-denied');
      return createHostMemberKnowledgePort({
        backend: options.backend,
        connectionId: options.connectionId,
        scope: binding.scope,
        library: value.library,
        allowDrafts: value.choice.allowDrafts,
        assertCurrent: async (signal) => {
          await current(signal);
          if (accepted.get(key) !== value) throw new ExecutionRunError('run-authority-denied');
        },
      });
    },
    fence() {
      fenced = true;
      accepted.clear();
      prepared.clear();
    },
  };
}
