import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalPayload } from '@zhuma/agent-core';
import {
  BASIC_TASK_EXECUTOR,
  EXECUTION_COMPOSITION_LIMITS,
  freezeExecutionRunComposition,
  readExecutionRunComposition,
  executionRunCompositionRequest,
  assertExecutionRunComposition,
} from '../dist/execution-run-composition.js';
import { compositionFacts, reader } from './execution-run-composition-fixture.mjs';

test('composition contract: explicit builtin/model becomes a copied frozen recoverable definition, not an official preset', () => {
  const facts = compositionFacts();
  const frozen = freezeExecutionRunComposition(facts);
  assert.equal(frozen.payload.executor.definition.name, 'Zhuma基础任务执行者');
  assert.equal(frozen.payload.executor.digest, BASIC_TASK_EXECUTOR.digest);
  assert.deepEqual(frozen.payload.toolAllowlist, []);
  assert.equal(frozen.payload.model.model, 'contract-model');
  assert.equal(frozen.payload.plan.ref.planId, facts.scope.planId);
  assert(Object.isFrozen(frozen.payload.executor.definition));
  assert.throws(() => {
    frozen.payload.model.model = 'mutated';
  }, TypeError);
  facts.model.model = 'changed-source';
  assert.equal(frozen.payload.model.model, 'contract-model');
  assert.deepEqual(readExecutionRunComposition(JSON.parse(JSON.stringify(frozen))), frozen);
  const request = executionRunCompositionRequest(frozen);
  assert.equal(request.selection.configurationId, frozen.configurationId);
  assert.equal(
    request.inputFingerprint,
    createHash('sha256')
      .update(JSON.stringify(['followup', request.firstMessage.text]))
      .digest('hex'),
  );
  assert.equal(request.expertVersionId, 'zhuma-basic-task-executor@1.0.0');
});

test('composition contract: required accepted input uses exact scoped handles and tool definition without copying source bodies', () => {
  const facts = compositionFacts({ upstream: true });
  const frozen = freezeExecutionRunComposition(facts);
  assert.equal(frozen.payload.inputs[0].artifactVersionId, 'artifact-1');
  assert.deepEqual(frozen.payload.tools, reader);
  assert.deepEqual(frozen.payload.toolAllowlist, ['read_accepted_input']);
  assert(frozen.payload.context.includes(frozen.payload.contextRefs[0]));
  assert(!JSON.stringify(frozen).includes('PRIVATE_SOURCE_BODY_NOT_IN_PROMPT'));
  const request = executionRunCompositionRequest(frozen);
  assert.equal(assertExecutionRunComposition(frozen, facts, request), undefined);
  const changed = structuredClone(facts);
  changed.tools.definition.parameters.properties.another = { type: 'boolean' };
  assert.notEqual(freezeExecutionRunComposition(changed).configurationId, frozen.configurationId);
  assert.throws(() => assertExecutionRunComposition(frozen, changed, request), {
    code: 'composition-mismatch',
  });
});

for (const [name, change] of [
  [
    'hidden',
    (facts) => {
      facts.inputs.items = [{ access: 'hidden', blocking: true, count: 1, message: 'hidden' }];
    },
  ],
  [
    'blocking visible',
    (facts) => {
      facts.inputs.items[0].blocking = true;
    },
  ],
  [
    'replaced',
    (facts) => {
      facts.inputs.items = [
        {
          access: 'pending',
          blocking: false,
          sourceNodeId: 'produce',
          pending: 'replaced',
          message: 'replaced',
        },
      ];
    },
  ],
  [
    'missing catalog',
    (facts) => {
      facts.inputs.items = [];
    },
  ],
  [
    'missing handoff refs',
    (facts) => {
      facts.node.handoff.inputRefs = [];
      facts.inputs.items = [];
    },
  ],
  [
    'different version',
    (facts) => {
      facts.inputs.items[0].artifactVersionId = 'artifact-2';
    },
  ],
  [
    'duplicate',
    (facts) => {
      facts.inputs.items.push(facts.inputs.items[0]);
    },
  ],
  [
    'foreign echo',
    (facts) => {
      facts.inputs.taskId = 'foreign-task';
    },
  ],
])
  test(`composition contract: ${name} cannot silently drop a required dependency`, () => {
    const facts = compositionFacts({ upstream: true });
    change(facts);
    assert.throws(() => freezeExecutionRunComposition(facts), {
      code: 'composition-input-unavailable',
    });
  });

test('composition contract: nonempty required inputs cannot be run with a text-only tool surface', () => {
  const facts = compositionFacts({ upstream: true });
  facts.tools = { kind: 'text-only' };
  assert.throws(() => freezeExecutionRunComposition(facts), {
    code: 'composition-input-reader-required',
  });
});

test('composition contract: explicit plan expert comes only from the exact AppliedPlan and never falls back to builtin', () => {
  const facts = compositionFacts({ upstream: true, expert: true });
  const saved = freezeExecutionRunComposition(facts);
  assert.equal(saved.payload.executor.ref.version, facts.scope.planId);
  assert.equal(saved.payload.executor.definition.id, 'qa');
  for (const change of [
    (copy) => {
      copy.executor = { kind: 'builtin' };
    },
    (copy) => {
      copy.executor.ref.version = 'fake-asset-version';
    },
    (copy) => {
      copy.workbench.appliedPlans[0].participants.find((item) => item.id === 'qa').instructions =
        '';
    },
    (copy) => {
      copy.executor.ref.id = 'missing-private-expert';
    },
  ]) {
    const copy = structuredClone(facts);
    change(copy);
    assert.throws(() => freezeExecutionRunComposition(copy), {
      code: 'composition-expert-unavailable',
    });
  }
  facts.workbench.participants.find((item) => item.id === 'qa').instructions =
    'new unfrozen global instructions';
  assert.deepEqual(
    freezeExecutionRunComposition(facts),
    saved,
    'the immutable plan definition is not replaced by current global text',
  );
});

test('composition contract: selected Skills/MCP refuse instead of masquerading as an empty authorized surface', () => {
  const facts = compositionFacts();
  const node = facts.workbench.appliedPlans[0].task.workflows[0].nodes[0];
  node.skillIds = ['api-skill'];
  facts.workbench.appliedPlans[0].assets = [structuredClone(facts.workbench.assets[0])];
  facts.node.handoff.skillRefs = [{ id: 'api-skill', version: facts.scope.planId }];
  assert.throws(() => freezeExecutionRunComposition(facts), {
    code: 'composition-resource-unsupported',
  });
});

test('composition contract: Unicode byte budgets and source limits reject rather than truncate content', () => {
  const facts = compositionFacts();
  facts.workbench.appliedPlans[0].task.goal = '界'.repeat(8000);
  const node = facts.workbench.appliedPlans[0].task.workflows[0].nodes[0];
  node.description = '界'.repeat(6000);
  node.input = '界'.repeat(2000);
  node.output = '界'.repeat(2000);
  facts.node.handoff.goal = `${node.title}\n\n${node.description}`;
  facts.node.handoff.inputNote = node.input;
  facts.node.handoff.expectedOutput = node.output;
  assert.throws(() => freezeExecutionRunComposition(facts), { code: 'composition-budget' });
  const oversized = {
    schemaVersion: 1,
    configurationId: 'x',
    payload: { x: '界'.repeat(EXECUTION_COMPOSITION_LIMITS.snapshotBytes) },
  };
  assert.throws(() => readExecutionRunComposition(oversized), { code: 'composition-budget' });
});

test('composition contract: implicit models, unknown tool fields and ambiguous plan sources are refused', () => {
  for (const change of [
    (facts) => {
      delete facts.model.provider;
    },
    (facts) => {
      delete facts.model.maxTokens;
    },
    (facts) => {
      facts.executor = { kind: 'unrecognized', ref: { id: 'qa', version: facts.scope.planId } };
    },
    (facts) => {
      facts.tools.definition.parameters = null;
    },
    (facts) => {
      facts.model.maxTokens = 65537;
    },
    (facts) => {
      facts.tools.definition.execute = () => {};
    },
    (facts) => {
      delete facts.tools.definition.outputSchema;
    },
  ]) {
    const facts = compositionFacts({ upstream: true });
    change(facts);
    assert.throws(() => freezeExecutionRunComposition(facts), { code: 'composition-invalid' });
  }
  const facts = compositionFacts();
  facts.workbench.appliedPlans.push(structuredClone(facts.workbench.appliedPlans[0]));
  assert.throws(() => freezeExecutionRunComposition(facts), {
    code: 'composition-source-mismatch',
  });
});

test('composition contract: input count has an explicit maximum before duplicate/source processing', () => {
  const facts = compositionFacts({ upstream: true });
  facts.inputs.items = Array.from({ length: 101 }, () => ({ ...facts.inputs.items[0] }));
  assert.throws(() => freezeExecutionRunComposition(facts), { code: 'composition-budget' });
});

test('composition contract: saved content, hash, derived message, scope and strict fields must all agree', () => {
  const facts = compositionFacts();
  const frozen = freezeExecutionRunComposition(facts);
  for (const change of [
    (copy) => {
      copy.configurationId = 'composition_' + '0'.repeat(64);
    },
    (copy) => {
      copy.payload.model.model = 'tampered';
    },
    (copy) => {
      copy.payload.extraCredential = 'not-accepted';
    },
    (copy) => {
      copy.payload.firstMessage.text = 'forged text';
      copy.payload.firstMessage.inputFingerprint = createHash('sha256')
        .update(JSON.stringify(['followup', 'forged text']))
        .digest('hex');
      copy.configurationId =
        'composition_' + createHash('sha256').update(canonicalPayload(copy.payload)).digest('hex');
    },
  ]) {
    const copy = structuredClone(frozen);
    change(copy);
    assert.throws(() => readExecutionRunComposition(copy), { code: 'composition-invalid' });
  }
  const copy = structuredClone(facts);
  copy.scope.spaceId = 'foreign';
  copy.inputs.spaceId = 'foreign';
  assert.throws(
    () => assertExecutionRunComposition(frozen, copy, executionRunCompositionRequest(frozen)),
    { code: 'composition-mismatch' },
  );
});
