// Explicit response-replay data; not authenticated users, stored files or a real review service.
export const revisionQuery = {
  taskId: 'task-orders',
  planId: 'plan-orders',
  revision: 1,
  nodeId: 'api-contract',
};
export const returnedNode = {
  ...revisionQuery,
  version: 5,
  status: 'needs-revision',
  goal: '补齐订单查询的接口约定',
  expectedOutput: '状态筛选、权限错误码和分页说明',
  assigneeId: 'chen',
  reviewerIds: ['lin', 'qa'],
  currentRoundId: 'return-round-2',
  artifacts: [
    { id: 'artifact-v1', version: 1, text: '接口初稿：GET /orders。' },
    { id: 'artifact-v2', version: 2, text: '增加 status 筛选，分页仍沿用原参数。' },
    { id: 'artifact-unrelated', version: 3, text: '不属于被退回轮次的较新产物。' },
  ],
  rounds: [
    {
      id: 'return-round-2',
      status: 'changes-requested',
      artifactVersionId: 'artifact-v2',
      reviewerIds: ['lin', 'qa'],
      ballots: [],
    },
  ],
  comments: [{ id: 'comment-auth', status: 'open' }],
  reviewOutcome: 'changes-requested',
};
export const revisionItem = {
  id: 'revise-orders',
  kind: 'deliver',
  actorId: 'chen',
  nodeId: returnedNode.nodeId,
  taskId: returnedNode.taskId,
  reason: 'revision-delivery',
  action: 'revise',
};
export function revisionView() {
  return {
    reviewed: {
      id: 'artifact-v2',
      version: 2,
      text: '增加 status 筛选，分页仍沿用原参数。',
      links: ['https://example.test/api/orders'],
      files: [{ id: 'file-contract-v2', mediaType: 'text/markdown', byteSize: 2400 }],
    },
    previous: {
      id: 'artifact-v1',
      version: 1,
      text: '接口初稿：GET /orders。',
      links: [],
      files: [],
    },
    notes: [
      {
        id: 'return-round-2-0',
        reviewerName: '林夏',
        body: '补充未登录与无权限两种错误码，说明状态参数的默认行为。',
        artifactVersionId: 'artifact-v2',
        citedCommentIds: ['comment-auth'],
      },
      {
        id: 'return-round-1-0',
        reviewerName: '质量专家',
        body: '请写明分页参数及空结果的返回结构。',
        artifactVersionId: 'artifact-v1',
        citedCommentIds: ['comment-page'],
      },
    ],
  };
}
