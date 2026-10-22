import { emptyWorkbench } from '../../packages/agent-core/dist/index.js';
import { uxParticipants, uxProject } from './workbench-ux.mjs';

// Synthetic planning data in the ordinary task list, never a fake execution report.
const node = (id, title, dependsOn, index, assignee = 0) => ({
  id,
  title,
  description: `完成${title}，整理交付材料并说明待确认事项。`,
  assigneeId: uxParticipants[assignee].id,
  reviewerIds: [uxParticipants[20].id],
  reviewRequired: true,
  dependsOn,
  skillIds: [],
  mcpIds: [],
  input: '项目目标与前置节点的交付材料',
  output: `${title}的说明与核对记录`,
  rationale: '',
  position: { x: 60 + index * 300, y: 100 },
});
export const treeTask = {
  id: 'ux-tree-task',
  projectId: uxProject.id,
  title: '订单与结算协同交付 · 演示数据',
  goal: '由季度交付目标逐层拆分订单与结算工作，订单下再拆分查询导出；并行分支在联调前汇合。仅验证三层工作流的编排与导航，不表示已执行。',
  participantIds: uxParticipants.map((p) => p.id),
  ownerId: uxParticipants[1].id,
  status: 'draft',
  updatedAt: '2026-10-22T12:00:00.000Z',
  workflows: [
    {
      id: 'tree-root',
      name: '季度交付',
      parentNodeId: null,
      nodes: [
        node('goal', '确认季度交付目标', [], 0, 1),
        node('orders', '完成订单改造', ['goal'], 1),
        node('reports', '交付结算报表', ['goal'], 1, 2),
        node('release', '联调与发布准备', ['orders', 'reports'], 2),
      ].map((n) => (n.id === 'reports' ? { ...n, position: { x: 360, y: 320 } } : n)),
    },
    {
      id: 'tree-orders',
      name: '订单改造',
      parentNodeId: 'orders',
      nodes: [
        node('contract', '冻结订单接口', [], 0),
        node('export', '实现查询与导出', ['contract'], 1, 18),
        node('integration', '联调回归', ['export'], 2),
      ],
    },
    {
      id: 'tree-export',
      name: '查询与导出',
      parentNodeId: 'export',
      nodes: [
        node('mapping', '字段映射', [], 0, 21),
        node('exceptions', '异常数据处理', ['mapping'], 1, 18),
        node('cases', '回归用例', ['mapping'], 1),
        node('summary', '汇总结果', ['exceptions', 'cases'], 2),
      ].map((n) => (n.id === 'cases' ? { ...n, position: { x: 360, y: 320 } } : n)),
    },
    {
      id: 'tree-reports',
      name: '结算报表',
      parentNodeId: 'reports',
      nodes: [
        node('finance', '确认财务口径', [], 0, 2),
        node('report-api', '实现报表接口', ['finance'], 1, 18),
        node('reconcile', '核对对账数据', ['report-api'], 2, 2),
      ],
    },
  ],
};
export function treeFixture() {
  return {
    ...emptyWorkbench(),
    projects: [structuredClone(uxProject)],
    participants: structuredClone(uxParticipants),
    tasks: [structuredClone(treeTask)],
  };
}
