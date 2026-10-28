import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readExecutionRunState,
  currentExecutionRun,
  beginExecutionRun,
  requestExecutionRunStop,
  recordExecutionRunEvent,
  assertExecutionRunQuiescent,
} from '../dist/execution-run-state.js';
import { afterExecutionRunCommit } from '../dist/execution-run-effects.js';
import {
  freezeExecutionRunComposition,
  executionRunCompositionRequest,
} from '../dist/execution-run-composition.js';
import { compositionFacts } from './execution-run-composition-fixture.mjs';
import {
  records,
  command,
  begin,
  event,
  applyEvent,
  accepted,
  stable,
  stopCommand,
  localWorkspace,
  available,
} from './execution-run-fixture.mjs';

const rejects = (fn, code) => assert.throws(fn, { code });
const stopped = (record) => {
  const requested = requestExecutionRunStop(record, stopCommand(record)).record;
  return applyEvent(requested, 'stopped', stable).record;
};

test('contract: parsed composition binding still rejects altered derivation, digest, source references, model and a valid foreign scope', () => {
  const facts = compositionFacts();
  const composition = freezeExecutionRunComposition(facts);
  const { firstMessage: _message, ...request } = executionRunCompositionRequest(composition);
  const record = begin(facts.node, { ...request, composition }, [facts.node]).record;
  assert.equal(
    readExecutionRunState(record).runs[0].composition.configurationId,
    composition.configurationId,
  );
  for (const fault of ['derivation', 'digest', 'references', 'model', 'scope']) {
    const changed = structuredClone(record);
    const run = changed.nativeExecution.runs[0];
    if (fault === 'derivation') run.composition.payload.context += ' altered';
    else if (fault === 'digest') run.composition.configurationId = `composition_${'0'.repeat(64)}`;
    else if (fault === 'references') run.attempt.contextRefs = ['unread-source'];
    else if (fault === 'model') run.selection.model = 'different-model';
    else {
      run.composition = freezeExecutionRunComposition({
        ...facts,
        scope: { ...facts.scope, runId: 'foreign-run' },
      });
      run.selection = executionRunCompositionRequest(run.composition).selection;
      run.attempt.configSnapshotId = run.composition.configurationId;
    }
    rejects(() => readExecutionRunState(changed), 'run-state-invalid');
  }
});

test('contract: missing native state is legacy, present malformed/unknown versions never become empty', () => {
  const row = records()[0];
  const before = structuredClone(row);
  assert.equal(readExecutionRunState(row), undefined);
  assertExecutionRunQuiescent(row);
  assert.deepEqual(row, before);
  for (const raw of [undefined, null, {}, { schemaVersion: 2 }, []])
    rejects(() => readExecutionRunState({ ...row, nativeExecution: raw }), 'run-state-invalid');
});
test('contract: begin reserves one persistent Run without changing node to running or touching old business fields', () => {
  const row = {
    ...records()[0],
    deliveryDraft: {
      version: 2,
      idempotencyKey: 'draft',
      fingerprint: 'draft-fp',
      text: 'unsent',
      links: [],
      files: [],
    },
    artifactsMarker: ['kept'],
    events: [],
    receipts: [
      { idempotencyKey: 'old-command', fingerprint: 'old', version: 1, disposition: 'applied' },
    ],
  };
  const before = structuredClone(row);
  const decision = begin(row);
  assert.deepEqual(row, before);
  assert.equal(decision.record.command.status, 'ready');
  assert.equal(decision.run.attempt.status, 'requested');
  assert.equal(decision.run.resources, 'held');
  assert.equal(decision.effect.kind, 'dispatch');
  assert.equal(decision.record.nativeExecution.currentRunId, 'run-1');
  for (const key of Object.keys(row)) assert.deepEqual(decision.record[key], row[key], key);
  rejects(() => assertExecutionRunQuiescent(decision.record), 'run-active');
});
test('contract: unavailable runtime or expert, wrong controller, invalid entry and browser-like extra flags refuse', () => {
  const row = records()[0];
  rejects(
    () => begin(row, {}, [row], { ...available, executorConnected: false }),
    'run-executor-disconnected',
  );
  rejects(
    () => begin(row, {}, [row], { ...available, expertEnabled: false }),
    'run-expert-disabled',
  );
  rejects(() => begin(row, { actorId: 'outside' }), 'run-not-controller');
  rejects(() => begin(row, { authorized: true }), 'run-validation');
  const { entryStatus: _entry, ...bad } = row.command;
  rejects(() => begin({ ...row, command: bad }), 'run-entry-invalid');
});
test('contract: same key/body replays without dispatch and fingerprints include actual configuration/workspace/input', () => {
  const row = records()[0];
  const input = command(row);
  const first = beginExecutionRun(row, input, [row], available);
  const replay = beginExecutionRun(
    first.record,
    { ...input, newRunId: 'discarded-new-id', newSegmentId: 'discarded-segment' },
    [first.record],
    available,
  );
  assert.equal(replay.disposition, 'replayed');
  assert.equal(replay.effect.kind, 'reconcile');
  assert.equal(replay.record, first.record);
  assert.equal(replay.run.attempt.id, 'run-1');
  for (const patch of [
    { inputFingerprint: 'b'.repeat(64) },
    { workspace: localWorkspace },
    { selection: { ...input.selection, model: 'changed' } },
  ])
    rejects(
      () => beginExecutionRun(first.record, { ...input, ...patch }, [first.record], available),
      'run-idempotency-mismatch',
    );
  rejects(
    () =>
      beginExecutionRun(first.record, { ...input, spaceId: 'south' }, [first.record], available),
    'run-scope-mismatch',
  );
  rejects(
    () =>
      begin(first.record, {
        requestId: 'new-command',
        newRunId: 'run-2',
        newSegmentId: 'segment-2',
      }),
    'run-active',
  );
  rejects(
    () => begin(first.record, { requestId: 'new-command', expectedRunVersion: 0 }),
    'run-conflict',
  );
});
test('contract: received/idle and several native turns retain one Run, generation, segment and claim', () => {
  let row = begin().record;
  row = applyEvent(row, 'received', { nativeSessionId: 'native-session-1' }).record;
  assert.equal(row.command.status, 'ready');
  assert.equal(currentExecutionRun(row).attempt.acknowledged, false);
  row = accepted(row);
  for (let i = 0; i < 3; i++) row = applyEvent(row, 'idle').record;
  assert.equal(row.nativeExecution.runs.length, 1);
  assert.equal(row.command.status, 'running');
  assert.equal(currentExecutionRun(row).resources, 'held');
  assert.equal(currentExecutionRun(row).attempt.generation, 1);
  assert.equal(currentExecutionRun(row).segmentId, 'segment-1');
  row = applyEvent(row, 'waiting').record;
  assert.equal(row.command.status, 'waiting-for-input');
  row = applyEvent(row, 'resumed').record;
  assert.equal(row.command.status, 'running');
});
test('contract: native metadata remains outside reconstructed core attempts', () => {
  const row = accepted(begin(records()[0], { workspace: localWorkspace }).record);
  const run = currentExecutionRun(row);
  assert.equal(run.segmentId, 'segment-1');
  assert.deepEqual(run.workspace, localWorkspace);
  assert.equal(run.actorId, 'chen');
  assert.equal(run.selection.configurationId, 'configuration-1');
  assert.equal('segmentId' in run.attempt, false);
});
test('contract: stop request and pending do not cancel node/release roots; confirmed stop requires complete native drain facts', () => {
  let row = accepted(begin(records()[0], { workspace: localWorkspace }).record);
  const request = stopCommand(row);
  row = requestExecutionRunStop(row, request).record;
  assert.equal(row.command.status, 'running');
  assert.equal(currentExecutionRun(row).attempt.stopPhase, 'requested');
  const replay = requestExecutionRunStop(row, request);
  assert.equal(replay.effect.kind, 'stop');
  assert.equal(replay.record, row);
  row = applyEvent(row, 'stop-pending').record;
  assert.equal(row.command.status, 'running');
  assert.equal(currentExecutionRun(row).resources, 'held');
  rejects(
    () => applyEvent(row, 'stopped', { ...stable, resourcesSettled: false }),
    'run-validation',
  );
  rejects(() => applyEvent(row, 'completed', stable), 'run-stopping');
  row = applyEvent(row, 'stopped', stable).record;
  assert.equal(row.command.status, 'cancelled');
  assert.equal(currentExecutionRun(row).resources, 'settled');
  assertExecutionRunQuiescent(row);
});
test('contract: unrequested cancellation does not become a stopped Run', () => {
  const row = accepted();
  const before = structuredClone(row);
  rejects(() => applyEvent(row, 'stopped', stable), 'run-cancel-unconfirmed');
  assert.deepEqual(row, before);
});
test('contract: terminal failure retains local writer until a separate stable cleanup receipt', () => {
  const [one, two] = records();
  let row = accepted(begin(one, { workspace: localWorkspace }, [one, two]).record);
  row = applyEvent(row, 'failed', { resourcesSettled: false }).record;
  assert.equal(row.command.status, 'failed');
  assert.equal(currentExecutionRun(row).resources, 'held');
  rejects(() => assertExecutionRunQuiescent(row), 'run-active');
  rejects(
    () =>
      begin(two, { workspace: { ...localWorkspace, grantId: 'another-grant-same-root' } }, [
        row,
        two,
      ]),
    'run-workspace-busy',
  );
  row = applyEvent(row, 'cleanup', stable).record;
  assertExecutionRunQuiescent(row);
  assert.equal(begin(two, { workspace: localWorkspace }, [row, two]).disposition, 'applied');
});
test('contract: retry/restart create new attempts only after cleanup, preserving old rows, generations and business obligations', () => {
  let row = {
    ...records()[0],
    command: { ...records()[0].command, status: 'needs-revision', entryStatus: 'needs-revision' },
  };
  row = accepted(begin(row).record);
  row = applyEvent(row, 'failed', { resourcesSettled: true }).record;
  const original = structuredClone(currentExecutionRun(row));
  row = begin(row, {
    mode: 'retry',
    requestId: 'retry-1',
    newRunId: 'run-2',
    newSegmentId: 'segment-2',
  }).record;
  assert.deepEqual(row.nativeExecution.runs[0], original);
  assert.equal(row.nativeExecution.runs[1].attempt.generation, 2);
  assert.equal(row.command.status, 'needs-revision');
  assert.equal(currentExecutionRun(row).attempt.entryNodeStatus, 'needs-revision');
  row = accepted(row);
  row = stopped(row);
  row = begin(row, {
    mode: 'restart',
    requestId: 'restart-1',
    newRunId: 'run-3',
    newSegmentId: 'segment-3',
  }).record;
  assert.equal(currentExecutionRun(row).attempt.generation, 3);
  assert.equal(row.command.status, 'needs-revision');
});
test('contract: pre-accept failure/stop preserves node entry and supports explicit retry without fabricating running', () => {
  let row = applyEvent(begin().record, 'failed', { resourcesSettled: true }).record;
  assert.equal(row.command.status, 'ready');
  row = begin(row, {
    mode: 'retry',
    requestId: 'retry',
    newRunId: 'run-2',
    newSegmentId: 'segment-2',
  }).record;
  assert.equal(row.command.status, 'ready');
  assert.equal(currentExecutionRun(row).attempt.generation, 2);
  row = stopped(row);
  assert.equal(row.command.status, 'ready');
  row = begin(row, {
    mode: 'restart',
    requestId: 'restart',
    newRunId: 'run-3',
    newSegmentId: 'segment-3',
  }).record;
  assert.equal(currentExecutionRun(row).attempt.generation, 3);
});
test('contract: explicit completion returns recorded entry, does not produce artifacts or unlock downstream', () => {
  const base = records()[0];
  const row = applyEvent(
    accepted(
      begin({ ...base, command: { ...base.command, entryStatus: 'needs-revision' } }).record,
    ),
    'completed',
    stable,
  ).record;
  assert.equal(row.command.status, 'needs-revision');
  assert.equal(row.artifactVersions.length, 0);
  assert.equal(currentExecutionRun(row).attempt.status, 'completed');
  assertExecutionRunQuiescent(row);
});
test('contract: stale run/segment/generation, duplicate altered event and old cursor cannot update node', () => {
  let row = accepted();
  for (const patch of [{ runId: 'unknown' }, { segmentId: 'old' }, { generation: 99 }])
    rejects(() => recordExecutionRunEvent(row, event(row, 'idle', patch)), 'run-scope-mismatch');
  const idle = event(row, 'idle');
  row = recordExecutionRunEvent(row, idle).record;
  assert.equal(recordExecutionRunEvent(row, idle).disposition, 'replayed');
  rejects(
    () => recordExecutionRunEvent(row, { ...idle, kind: 'dispatch-unknown' }),
    'run-event-mismatch',
  );
  assert.equal(recordExecutionRunEvent(row, { ...idle, sequence: 1 }).disposition, 'ignored');
  row = applyEvent(row, 'failed', { resourcesSettled: true }).record;
  row = begin(row, {
    mode: 'retry',
    requestId: 'retry',
    newRunId: 'run-2',
    newSegmentId: 'segment-2',
  }).record;
  assert.equal(recordExecutionRunEvent(row, { ...idle, sequence: 100 }).disposition, 'ignored');
});
test('contract: JSON reopen validates complete state and never creates a dispatch effect', () => {
  const row = accepted();
  const copy = JSON.parse(JSON.stringify(row));
  const state = readExecutionRunState(copy);
  assert.equal(state.runs.length, 1);
  assert.equal(currentExecutionRun(copy).attempt.id, 'run-1');
  assert.deepEqual(copy, row);
  for (const mutate of [
    (r) => {
      r.nativeExecution.schemaVersion = 2;
    },
    (r) => {
      r.nativeExecution.runs[0].attempt.generation = 2;
    },
    (r) => {
      r.nativeExecution.runs[0].segmentId = '';
    },
    (r) => {
      r.nativeExecution.runs[0].extra = true;
    },
    (r) => {
      r.command.status = 'completed';
    },
    (r) => {
      r.nativeExecution.runs[0].resources = 'settled';
    },
  ]) {
    const broken = structuredClone(copy);
    mutate(broken);
    rejects(() => readExecutionRunState(broken), 'run-state-invalid');
  }
});
test('contract: failed durable write cannot dispatch, replay only reconciles and unknown native errors never report completion', async () => {
  const calls = [];
  const driver = {
    dispatch: async () => calls.push('dispatch'),
    reconcile: async () => calls.push('reconcile'),
    stop: async () => calls.push('stop'),
  };
  await assert.rejects(
    afterExecutionRunCommit(async () => {
      throw Error('disk unavailable');
    }, driver),
  );
  assert.deepEqual(calls, []);
  const first = begin();
  await afterExecutionRunCommit(async () => first, driver);
  assert.deepEqual(calls, ['dispatch']);
  const replay = beginExecutionRun(first.record, command(records()[0]), [first.record], available);
  await afterExecutionRunCommit(async () => replay, driver);
  assert.deepEqual(calls, ['dispatch', 'reconcile']);
  await assert.rejects(
    afterExecutionRunCommit(async () => first, {
      ...driver,
      dispatch: async () => {
        throw Error('provider-private-error');
      },
    }),
    { code: 'run-effect-unknown', message: '本地运行操作未完成。' },
  );
  assert.equal(currentExecutionRun(first.record).resources, 'held');
});
test('contract: a shared owner queue admits only one of two concurrent new begins', async () => {
  let row = records()[0];
  let tail = Promise.resolve();
  let dispatches = 0;
  const transact = (input) => {
    const operation = tail.then(async () => {
      const decision = beginExecutionRun(row, input, [row], available);
      await Promise.resolve();
      row = decision.record;
      return decision;
    });
    tail = operation.catch(() => undefined);
    return operation;
  };
  const driver = {
    dispatch: async () => {
      dispatches++;
    },
    reconcile: async () => {},
    stop: async () => {},
  };
  const one = command(row);
  const two = { ...one, requestId: 'other', newRunId: 'run-other', newSegmentId: 'segment-other' };
  const results = await Promise.allSettled([
    afterExecutionRunCommit(() => transact(one), driver),
    afterExecutionRunCommit(() => transact(two), driver),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(dispatches, 1);
  assert.equal(row.nativeExecution.runs.length, 1);
});

test('contract: Run begin/stop/late events preserve existing drafts, artifact/round history, comments, business receipts and events', () => {
  const row = {
    ...records()[0],
    deliveryDraft: {
      version: 2,
      idempotencyKey: 'draft',
      fingerprint: 'draft',
      text: 'unsent draft',
      links: [],
      files: [],
    },
    rounds: [
      {
        id: 'old-round',
        status: 'voided',
        artifactVersionId: 'old-artifact',
        reviewerIds: ['outside'],
        ballots: [],
      },
    ],
    artifactVersions: [
      {
        id: 'old-artifact',
        nodeId: 'produce',
        version: 1,
        submittedBy: 'chen',
        text: 'old body',
        files: [],
        links: [],
      },
    ],
    comments: [{ id: 'old-comment', body: 'keep this opinion' }],
    receipts: [
      {
        idempotencyKey: 'human-command',
        fingerprint: 'old-body',
        version: 1,
        disposition: 'applied',
      },
    ],
    events: [{ eventId: 'old-event', sequence: 1, type: 'node-started' }],
  };
  const protectedKeys = [
    'deliveryDraft',
    'rounds',
    'artifactVersions',
    'comments',
    'receipts',
    'events',
  ];
  const snapshot = structuredClone(row);
  let next = accepted(begin(row).record);
  next = requestExecutionRunStop(next, stopCommand(next)).record;
  next = applyEvent(next, 'stop-pending').record;
  next = applyEvent(next, 'stopped', stable).record;
  next = recordExecutionRunEvent(
    next,
    event(next, 'completed', { ...stable, sequence: 100 }),
  ).record;
  for (const key of protectedKeys) assert.deepEqual(next[key], snapshot[key], key);
  assert.deepEqual(row, snapshot, 'no in-place mutation of the storage-owned input');
});

test('contract: unknown admission retains the claim and only a read reconciliation can follow its original key', async () => {
  const base = records()[0];
  const input = command(base);
  let row = beginExecutionRun(base, input, [base], available).record;
  row = applyEvent(row, 'dispatch-unknown').record;
  const replay = beginExecutionRun(row, input, [row], available);
  assert.equal(replay.effect.kind, 'reconcile');
  assert.equal(replay.run.dispatch, 'unknown');
  let dispatch = 0,
    reconciliation = 0;
  await afterExecutionRunCommit(async () => replay, {
    dispatch: async () => {
      dispatch++;
    },
    reconcile: async () => {
      reconciliation++;
      return 'unknown';
    },
    stop: async () => {},
  });
  assert.equal(dispatch, 0);
  assert.equal(reconciliation, 1);
  assert.equal(currentExecutionRun(row).resources, 'held');
});

test('contract: a new attempt carries an explicit old/new scope pair for C handoff and never changes the old scope', () => {
  let row = accepted();
  row = applyEvent(row, 'failed', { resourcesSettled: true }).record;
  const decision = begin(row, {
    mode: 'retry',
    requestId: 'retry',
    newRunId: 'run-2',
    newSegmentId: 'segment-2',
  });
  assert.equal(decision.effect.previousScope.runId, 'run-1');
  assert.equal(decision.effect.previousScope.generation, 1);
  assert.equal(decision.effect.scope.runId, 'run-2');
  assert.equal(decision.effect.scope.generation, 2);
  assert.equal(decision.record.nativeExecution.runs[0].segmentId, 'segment-1');
  rejects(
    () => applyEvent(decision.record, 'received', { nativeSessionId: 'native-session-1' }),
    'run-session-mismatch',
  );
  const next = accepted(decision.record);
  assert.equal(currentExecutionRun(next).attempt.sessionId, 'native-session-2');
});
