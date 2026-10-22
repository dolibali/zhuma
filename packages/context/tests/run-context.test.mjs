import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assembleRunContext,
  claimWritableWorkspace,
  isolateWorkspaceId,
  releaseWritableWorkspace,
} from '@zhuma/context';

const item = (overrides) => ({
  id: 'goal-1',
  kind: 'goal',
  sourceId: 'task-portal',
  version: '3',
  permission: 'granted',
  summary: '确认企业开户字段',
  required: true,
  ...overrides,
});

test('契约：运行上下文带来源、版本和权限，且不包含本机路径', () => {
  const result = assembleRunContext({
    id: 'ctx-1',
    taskId: 'task-portal',
    nodeId: 'node-fields',
    planRevision: 3,
    items: [
      item({}),
      item({
        id: 'parent-1',
        kind: 'parent-goal',
        sourceId: 'task-parent',
        version: '1',
        summary: '企业客户门户季度交付',
      }),
      item({
        id: 'file-1',
        kind: 'project-knowledge',
        sourceId: 'spec',
        version: '2',
        summary: '开户字段规范',
        file: { exists: true, readable: true, pathAccepted: true },
      }),
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.manifest.citations.length, 3);
  assert.equal(result.manifest.citations[2].reference, 'project-knowledge:spec@2');
  assert.equal(JSON.stringify(result.manifest).includes('/home/'), false);
  assert.equal(JSON.stringify(result.manifest).includes('path'), false);
});

test('契约：缺文件、不可读或无权限时阻塞，并指出来源', () => {
  const blocked = assembleRunContext({
    id: 'ctx-2',
    taskId: 'task-portal',
    nodeId: 'node-fields',
    planRevision: 3,
    items: [
      item({}),
      item({
        id: 'missing',
        kind: 'project-knowledge',
        sourceId: '外部映射表',
        version: '9',
        summary: '映射表',
        required: false,
        file: { exists: false, readable: false, pathAccepted: true },
      }),
      item({
        id: 'secret',
        kind: 'accepted-upstream-artifact',
        sourceId: 'art-secret',
        version: '4',
        permission: 'denied',
        summary: '不可见',
      }),
    ],
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'context-blocked');
  assert.deepEqual(
    blocked.manifest.blocks.map((block) => `${block.sourceId}:${block.reason}`),
    ['外部映射表:missing-file', 'art-secret:permission-denied'],
  );
  assert.equal(
    blocked.manifest.citations.some((item) => item.sourceId === '外部映射表'),
    false,
  );
  const rejected = assembleRunContext({
    id: 'ctx-3',
    taskId: 'task',
    nodeId: 'node',
    planRevision: 1,
    items: [
      item({
        id: 'bad-path',
        sourceId: 'local',
        file: { exists: true, readable: true, pathAccepted: false },
      }),
    ],
  });
  assert.equal(rejected.manifest.blocks[0].reason, 'path-rejected');
  assert.equal(JSON.stringify(rejected.manifest).includes('/Users/'), false);
});

test('契约：同一节点共用工作区，第二个写入者在释放前被拒绝', () => {
  const first = isolateWorkspaceId('node-1');
  const second = isolateWorkspaceId('node-1');
  const other = isolateWorkspaceId('node-2');
  assert.equal(first, 'node-workspace:node-1');
  assert.equal(first, second);
  assert.notEqual(first, other);
  const claimed = claimWritableWorkspace({
    workspaceId: first,
    writerRunId: 'run-1',
    existing: [],
  });
  assert.equal(claimed.ok, true);
  const busy = claimWritableWorkspace({
    workspaceId: first,
    writerRunId: 'run-9',
    existing: [claimed.claim],
  });
  assert.equal(busy.code, 'workspace-busy');
  assert.equal(busy.writerRunId, 'run-1');
  const released = releaseWritableWorkspace([claimed.claim], first, 'run-1');
  const again = claimWritableWorkspace({
    workspaceId: first,
    writerRunId: 'run-9',
    existing: released,
  });
  assert.equal(again.ok, true);
});
