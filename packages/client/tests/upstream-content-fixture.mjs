// Public DTO replay only: not authorization, accepted-work or actual file-byte evidence.
export const upstreamQuery = {
  taskId: 'task-a',
  planId: 'plan-a',
  revision: 2,
  nodeId: 'implement-api',
  sourceNodeId: 'api-contract',
  artifactVersionId: 'artifact:accept-api-contract-v2',
  expectedArtifactVersion: 2,
};
export function upstreamContent(query = upstreamQuery) {
  return {
    actorId: 'chen',
    spaceId: 'team-a',
    downstream: {
      taskId: query.taskId,
      planId: query.planId,
      revision: query.revision,
      nodeId: query.nodeId,
    },
    source: {
      taskId: query.taskId,
      planId: query.planId,
      revision: query.revision,
      nodeId: query.sourceNodeId,
    },
    version: { id: query.artifactVersionId, version: 2 },
    content: {
      text: '订单接口约定\n缺少状态筛选时保持旧返回结构。',
      links: ['https://example.com/contracts/orders'],
      files: [],
    },
  };
}
