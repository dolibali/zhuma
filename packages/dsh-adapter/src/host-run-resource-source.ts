import {
  canonicalPayload,
  createExecutionHandoff,
  createNodeHandoffs,
  type Workbench,
} from '@zhuma/agent-core';
import type { BeginRunRequest, ExecutionService } from './execution-service.js';
import type { MemberRequest } from './member-session.js';
import type { createHostRunSkillPolicies } from './host-run-skill-policy.js';
import type { ExecutionRunAuthorities } from './execution-run-authority.js';
import type { NativeSessionBinding, NativeWorkGrant } from './native-work-session-contract.js';
import type { ExecutionRunResourceProducer } from './execution-run-resources.js';
import {
  assertExecutionRunCompositionBinding,
  executionRunCompositionRequest,
  readExecutionRunComposition,
  type FrozenExecutionRunComposition,
} from './execution-run-composition.js';
import {
  EXECUTION_RESOURCE_SOURCE_VERSION,
  ExecutionRunResourceError,
  executionResourceDigest,
  freezeExecutionRunResources,
  type ExecutionRunResourceCatalog,
} from './execution-run-resource-snapshot.js';

type Locator = Parameters<ExecutionService['readRunNode']>[0] & { readonly spaceId: string };
type Execution = Pick<
  ExecutionService,
  'readRunNode' | 'readRunCompositionInputs' | 'readRunComposition'
>;
type Policies = ReturnType<typeof createHostRunSkillPolicies>;

/** Structurally matches the frozen D private operation port. Not a Run grant. */
export interface HostRunResourceQualification {
  readonly catalog: ExecutionRunResourceCatalog;
  readonly signal: AbortSignal;
  assertCurrent(): undefined;
  release(): undefined;
}
function unavailable(): never {
  throw new ExecutionRunResourceError('resources-unavailable');
}
function immutable<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
function resourcesOf(snapshot: FrozenExecutionRunComposition) {
  return snapshot.schemaVersion === 2 && snapshot.payload.resources
    ? snapshot.payload.resources
    : { sourceVersion: EXECUTION_RESOURCE_SOURCE_VERSION, skills: [], mcp: [] };
}

/** Original-package metadata only. Both operations run OUTSIDE the execution write queue.
 * The continuing native resource producer must use signal, never a qualification's signal.
 */
export function createHostRunResourceSource(options: {
  readonly execution: Execution;
  readonly policies: Policies;
  readonly signal: AbortSignal;
  readWorkbench(): Workbench;
}) {
  const { execution, policies, signal } = options;
  const readNode = execution.readRunNode;
  const readInputs = execution.readRunCompositionInputs;
  const readPolicies = policies.read;
  const qualifyPolicies = policies.qualify;
  const readComposition = execution.readRunComposition;
  const readWorkbench = options.readWorkbench;
  function active() {
    if (
      signal.aborted ||
      options.signal !== signal ||
      options.execution !== execution ||
      options.policies !== policies ||
      execution.readRunNode !== readNode ||
      execution.readRunCompositionInputs !== readInputs ||
      policies.read !== readPolicies ||
      policies.qualify !== qualifyPolicies ||
      execution.readRunComposition !== readComposition ||
      options.readWorkbench !== readWorkbench
    )
      unavailable();
  }
  async function selected(request: MemberRequest, locator: Locator) {
    active();
    const fixed = Object.freeze({
      taskId: locator.taskId,
      planId: locator.planId,
      revision: locator.revision,
      nodeId: locator.nodeId,
      spaceId: locator.spaceId,
    });
    async function authorize() {
      active();
      const result = await readInputs.call(execution, request, fixed);
      active();
      if (!result.ok) unavailable();
      const value = result.value;
      if (
        !value.actorId ||
        value.spaceId !== fixed.spaceId ||
        value.taskId !== fixed.taskId ||
        value.planId !== fixed.planId ||
        value.revision !== fixed.revision ||
        value.nodeId !== fixed.nodeId ||
        !Array.isArray(value.items) ||
        value.items.some((item) => item.access !== 'visible' || item.blocking)
      )
        unavailable();
      return value.actorId;
    }
    // Even an empty/MCP-only domain must pass the same real original-request gate.
    const actorId = await authorize();
    const node = readNode.call(execution, fixed);
    if (!node) unavailable();
    const applied = createExecutionHandoff(fixed, readWorkbench());
    const handoff = createNodeHandoffs(applied).find((item) => item.nodeId === fixed.nodeId);
    if (
      !handoff ||
      node.taskId !== fixed.taskId ||
      node.planId !== fixed.planId ||
      node.revision !== fixed.revision ||
      node.nodeId !== fixed.nodeId ||
      canonicalPayload({ ...handoff, inputRefs: node.handoff.inputRefs }) !==
        canonicalPayload(node.handoff)
    )
      unavailable();
    const sourceDigest = executionResourceDigest({ applied, handoff: node.handoff });
    // Until a genuinely qualified private MCP binding is available, refuse it.
    if (handoff.mcpRefs.length) unavailable();
    const policy = await qualifyPolicies.call(policies, request, fixed);
    const assertSource = () => {
      try {
        active();
        policy.assertCurrent();
        const current = readNode.call(execution, fixed);
        if (
          !current ||
          executionResourceDigest({
            applied: createExecutionHandoff(fixed, readWorkbench()),
            handoff: current.handoff,
          }) !== sourceDigest
        )
          unavailable();
      } catch {
        return unavailable();
      }
    };
    assertSource();
    if ((await authorize()) !== actorId) unavailable();
    assertSource();
    const catalog: ExecutionRunResourceCatalog = immutable({
      sourceVersion: EXECUTION_RESOURCE_SOURCE_VERSION,
      mcp: [],
      skills: structuredClone(policy.policies),
    });
    const expert =
      handoff.assignee.kind === 'expert'
        ? applied.participants.find((item) => item.id === handoff.assignee.id)
        : undefined;
    // Use D's actual pure validation; no independent descriptor or policy schema.
    const resources = freezeExecutionRunResources(applied, handoff, expert, catalog);
    return { actorId, catalog, resources, assertSource, handoff };
  }
  return {
    signal,
    /** Called only in unpublished native compose, after durable Run admission. */
    async producer(
      request: MemberRequest,
      raw: FrozenExecutionRunComposition,
      binding: NativeSessionBinding,
      grant: NativeWorkGrant,
      authorities: Pick<ExecutionRunAuthorities, 'assertGrant'>,
    ): Promise<ExecutionRunResourceProducer> {
      try {
        active();
        const assertGrant = authorities.assertGrant;
        const snapshot = readExecutionRunComposition(raw);
        const fingerprint = canonicalPayload(snapshot);
        const projected = executionRunCompositionRequest(snapshot);
        const locator = {
          taskId: grant.scope.taskId,
          planId: grant.scope.planId,
          revision: grant.scope.revision,
          nodeId: grant.scope.nodeId,
          runId: grant.scope.runId,
        };
        function currentRun() {
          active();
          if (authorities.assertGrant !== assertGrant) unavailable();
          assertGrant.call(authorities, grant, 'send');
          grant.signal.throwIfAborted();
          assertExecutionRunCompositionBinding(snapshot, binding.scope, projected);
          if (
            canonicalPayload(grant.scope) !== canonicalPayload(binding.scope) ||
            canonicalPayload(binding.selection) !== canonicalPayload(projected.selection) ||
            canonicalPayload(readComposition.call(execution, locator)) !== fingerprint
          )
            unavailable();
        }
        currentRun();
        const source = await selected(request, grant.scope);
        currentRun();
        const frozen = resourcesOf(snapshot);
        if (
          source.actorId !== binding.scope.actorId ||
          canonicalPayload(source.resources) !== canonicalPayload(frozen)
        )
          unavailable();
        source.assertSource();
        return Object.freeze<ExecutionRunResourceProducer>({
          sourceVersion: EXECUTION_RESOURCE_SOURCE_VERSION,
          // The operation qualification is deliberately absent from this lifetime.
          signal: AbortSignal.any([signal, grant.signal]),
          assertCurrent(currentSnapshot, currentBinding, currentGrant) {
            try {
              currentRun();
              if (
                currentGrant !== grant ||
                currentBinding !== binding ||
                canonicalPayload(currentSnapshot) !== fingerprint
              )
                unavailable();
              source.assertSource();
              return undefined;
            } catch {
              return unavailable();
            }
          },
          async openMcp() {
            return unavailable();
          },
        });
      } catch {
        return unavailable();
      }
    },
    async catalog(request: MemberRequest, locator: Locator): Promise<ExecutionRunResourceCatalog> {
      try {
        return (await selected(request, locator)).catalog;
      } catch {
        return unavailable();
      }
    },
    async prepareResourceCatalog(
      request: MemberRequest,
      command: BeginRunRequest,
    ): Promise<HostRunResourceQualification> {
      try {
        active();
        const snapshot = readExecutionRunComposition(command.composition);
        const source = await selected(request, command);
        const expected = {
          ...snapshot.payload.scope,
          actorId: source.actorId,
          spaceId: command.spaceId,
          taskId: command.taskId,
          planId: command.planId,
          revision: command.revision,
          nodeId: command.nodeId,
          runId: command.newRunId,
          segmentId: command.newSegmentId,
        };
        assertExecutionRunCompositionBinding(snapshot, expected, command);
        if (canonicalPayload(resourcesOf(snapshot)) !== canonicalPayload(source.resources))
          unavailable();
        const fingerprint = canonicalPayload(command);
        const operation = new AbortController();
        const current = () => {
          operation.signal.throwIfAborted();
          source.assertSource();
          if (canonicalPayload(command) !== fingerprint) unavailable();
          return undefined;
        };
        current();
        return Object.freeze({
          catalog: source.catalog,
          signal: AbortSignal.any([signal, operation.signal]),
          assertCurrent: current,
          release() {
            operation.abort();
            return undefined;
          },
        });
      } catch {
        return unavailable();
      }
    },
  };
}
