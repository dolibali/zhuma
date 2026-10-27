import type { Context } from '@deepseek-ai/cordis';
import { scopeOf } from '@deepseek-ai/dsh-scope';
import { canonicalPayload } from '@zhuma/agent-core';
import {
  readExecutionReviewComposition,
  type FrozenExecutionReviewComposition,
} from './execution-review-composition.js';
import type { ExecutionReviewDriveGrant } from './execution-review-drive-authority.js';
import type { NativeSessionBinding, NativeWorkGrant } from './native-work-session-contract.js';
import { nativeReviewContextFromScope } from './native-work-session-review-contract.js';
import type { NativeWorkSessionService } from './native-work-session.js';
import type { createHostRunResourceSource } from './host-run-resource-source.js';
import type { createHostRunConfiguration } from './host-run-configuration.js';
import {
  describeExecutionScopedResourceTool,
  registerExecutionResourceScope,
} from './execution-run-resources.js';
import { ExecutionRunResourceError } from './execution-run-resource-snapshot.js';

function unavailable(): never {
  throw new ExecutionRunResourceError('resources-unavailable');
}

/** Adopts reviewer resources in the original unpublished Agent. Author Run
 * registration, workspace tools and author history are never consulted. */
export async function adoptHostReviewResources(
  ctx: Context,
  input: {
    readonly composition: FrozenExecutionReviewComposition;
    readonly drive: ExecutionReviewDriveGrant;
    readonly binding: NativeSessionBinding;
    readonly grant: NativeWorkGrant;
  },
  options: {
    readonly native: Pick<NativeWorkSessionService, 'reviewContext'>;
    readonly resources: Pick<ReturnType<typeof createHostRunResourceSource>, 'reviewProducer'>;
    readonly assertModel: ReturnType<
      typeof createHostRunConfiguration
    >['assertReviewConfiguration'];
    readonly readNode: (
      scope: ExecutionReviewDriveGrant['scope'],
    ) => Parameters<ReturnType<typeof createHostRunConfiguration>['assertReviewConfiguration']>[2];
  },
) {
  const { binding, grant, drive } = input;
  const snapshot = readExecutionReviewComposition(input.composition);
  const context = nativeReviewContextFromScope(snapshot.payload.scope);
  const native = options.native,
    readContext = native.reviewContext;
  const source = options.resources,
    makeProducer = source.reviewProducer;
  const assertModel = options.assertModel,
    readNode = options.readNode;
  const current = (): undefined => {
    if (
      options.native !== native ||
      native.reviewContext !== readContext ||
      options.resources !== source ||
      source.reviewProducer !== makeProducer ||
      options.assertModel !== assertModel ||
      options.readNode !== readNode ||
      canonicalPayload(readContext.call(native, grant)) !== canonicalPayload(context)
    )
      unavailable();
    assertModel(drive.scope.actorId, drive.scope.spaceId, readNode(drive.scope), snapshot);
    return undefined;
  };
  current();
  const producer = makeProducer.call(source, snapshot, binding, grant, drive);
  const adopted = await registerExecutionResourceScope(ctx, snapshot.payload.resources, grant, {
    sourceVersion: producer.sourceVersion,
    signal: producer.signal,
    assertCurrent() {
      current();
      return producer.assertCurrent();
    },
    openMcp: (resource, signal) => producer.openMcp(resource, signal),
  });
  try {
    await adopted.ready;
    current();
    producer.assertCurrent();
    const tools = ctx.get('tools'),
      scope = scopeOf(ctx);
    if (!tools || !scope) unavailable();
    const descriptors = adopted.toolAllowlist.map((name) => {
      const definition = tools.get(name, scope);
      if (!definition) unavailable();
      return describeExecutionScopedResourceTool(definition);
    });
    return Object.freeze({
      scope: snapshot.payload.scope,
      configurationId: snapshot.configurationId,
      // Normal SDK retirement disposes the registration. Persistent authority
      // is separate; live assertions still reject an unready/disposed resource.
      signal: producer.signal,
      context: '',
      toolAllowlist: adopted.toolAllowlist,
      descriptors: Object.freeze(descriptors),
      ready: adopted.ready,
      assertCurrent() {
        current();
        producer.assertCurrent();
        if (adopted.signal.aborted) unavailable();
        for (const expected of descriptors) {
          const actual = tools.get(expected.name, scope);
          if (
            !actual ||
            canonicalPayload(describeExecutionScopedResourceTool(actual)) !==
              canonicalPayload(expected)
          )
            unavailable();
        }
        return undefined;
      },
      drain: adopted.drain,
      dispose: adopted.dispose,
    });
  } catch (error) {
    await adopted.dispose();
    throw error;
  }
}
