import { emptyWorkbench } from '../../packages/agent-core/dist/index.js';

export function fixture() {
  const state = emptyWorkbench();
  state.projects = [{ id: 'project', name: '客户门户', description: '企业客户门户' }];
  state.participants = [
    {
      id: 'chen',
      name: '陈宁',
      kind: 'human',
      role: '接口设计',
      capabilities: ['API'],
      instructions: '',
      available: true,
    },
    {
      id: 'qa',
      name: '质量专家',
      kind: 'expert',
      role: '独立测试',
      capabilities: ['回归测试'],
      instructions: '',
      available: true,
    },
    {
      id: 'outside',
      name: '其他成员',
      kind: 'human',
      role: '',
      capabilities: [],
      instructions: '',
      available: true,
    },
  ];
  state.assets = [
    {
      id: 'api-skill',
      name: '接口规范',
      kind: 'skill',
      description: '设计 API',
      content: '明确输入输出和错误码。',
      available: true,
    },
  ];
  const node = {
    id: 'node-1',
    title: '设计登录接口',
    description: '',
    assigneeId: 'chen',
    reviewerIds: ['qa'],
    reviewRequired: true,
    dependsOn: [],
    skillIds: ['api-skill'],
    mcpIds: [],
    input: '需求文档',
    output: '接口定义',
    rationale: '陈宁负责接口，质量专家独立评审。',
    position: { x: 0, y: 0 },
  };
  const task = {
    id: 'task',
    projectId: 'project',
    title: '账号登录',
    goal: '设计登录流程',
    participantIds: ['chen', 'qa'],
    ownerId: 'chen',
    workflows: [{ id: 'root', name: '登录工作流', parentNodeId: null, nodes: [node] }],
    status: 'draft',
    updatedAt: '2026-10-22T00:00:00.000Z',
  };
  state.tasks = [task];
  return { state, task, node };
}
