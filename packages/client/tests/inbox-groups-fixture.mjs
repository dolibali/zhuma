// Display/RPC response replay only, not authenticated membership or a second inbox state machine.
import { deliveryNode, reviewNode } from './browser/execution-fixture.mjs';
import { returnedNode } from './revision-fixture.mjs';
export function groupedInbox() {
  const nodes = [
    deliveryNode,
    returnedNode,
    reviewNode,
    { ...deliveryNode, nodeId: 'input', goal: '补充发票处理规则', status: 'waiting-for-input' },
    { ...deliveryNode, nodeId: 'confirm', goal: '确认子流程交付', status: 'ready' },
    { ...deliveryNode, nodeId: 'running', goal: '正在生成帮助文案', status: 'running' },
    {
      ...deliveryNode,
      nodeId: 'no-item',
      goal: '只有节点状态的等待事项',
      status: 'waiting-for-input',
    },
  ];
  const facts = [
    ['deliver', 'assignee-delivery', 'submit'],
    ['deliver', 'revision-delivery', 'revise'],
    ['review', 'review-assigned', 'review'],
    ['deliver', 'input-required', 'provide-input'],
    ['confirm', 'parent-confirmation', 'confirm'],
    ['deliver', 'agent-assisted-delivery', 'continue-handling'],
  ];
  const items = facts.map(([kind, reason, action], i) => ({
    id: `item-${i}`,
    kind,
    reason,
    action,
    taskId: nodes[i].taskId,
    nodeId: nodes[i].nodeId,
    actorId: 'chen',
    ...(i === 4 ? { detail: '请核对发票范围后确认交付。' } : {}),
  }));
  const places = items.map((item) => ({
    itemId: item.id,
    taskPath: '订单项目 / 结算能力升级 / 客户服务 / 交付说明',
    ownerName: '林夏',
  }));
  return { actorId: 'chen', items, nodes, places };
}
