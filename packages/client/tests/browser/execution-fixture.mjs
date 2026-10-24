// Contract replay only; no task state machine or production storage.
export const reviewNode = {
  taskId: 'task-orders',
  planId: 'plan-orders',
  revision: 1,
  nodeId: 'design',
  version: 2,
  status: 'in-review',
  goal: '确认订单状态接口',
  expectedOutput: '接口说明与错误码',
  assigneeId: 'mei',
  reviewerIds: ['chen', 'lin'],
  currentRoundId: 'round-1',
  artifacts: [
    {
      id: 'artifact-1',
      version: 1,
      text: '订单状态支持待支付、已支付、已取消。\n取消原因单独返回。',
      links: ['https://example.com/design'],
    },
  ],
  rounds: [
    {
      id: 'round-1',
      status: 'open',
      artifactVersionId: 'artifact-1',
      reviewerIds: ['chen', 'lin'],
      ballots: [],
    },
  ],
  comments: [],
};
export const deliveryNode = {
  ...reviewNode,
  nodeId: 'copy',
  assigneeId: 'chen',
  status: 'ready',
  goal: '编写订单状态帮助文案',
  expectedOutput: '面向客户的状态说明',
  currentRoundId: undefined,
  rounds: [],
  artifacts: [],
};
export const reviseNode = {
  ...deliveryNode,
  nodeId: 'revise',
  status: 'needs-revision',
  goal: '补充取消订单的边界说明',
};
export function inbox(nodes) {
  return {
    actorId: 'chen',
    nodes,
    items: nodes.map((node) => ({
      id: `inbox-${node.nodeId}`,
      taskId: node.taskId,
      nodeId: node.nodeId,
      actorId: 'chen',
      kind: node.status === 'in-review' ? 'review' : 'deliver',
      reason:
        node.status === 'in-review'
          ? 'review-assigned'
          : node.status === 'needs-revision'
            ? 'revision-delivery'
            : 'assignee-delivery',
      action:
        node.status === 'in-review'
          ? 'review'
          : node.status === 'needs-revision'
            ? 'revise'
            : 'submit',
    })),
  };
}
