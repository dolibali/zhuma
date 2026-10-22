// Explicit synthetic fixture for visual/interaction verification; never loaded by the product.
export const uxProject = {
  id: 'ux1-project',
  name: '企业订单门户 · UX 验证数据',
  description: '模拟公司采购门户。用于长内容、多人选择和并行工作流验证，不连接业务系统。',
};
const names = [
  '陈宁',
  '林可',
  '周禾',
  '许知远',
  '沈清',
  '陆遥',
  '顾言',
  '宋安',
  '唐悦',
  '江沐',
  '叶晨',
  '黎川',
  '程澈',
  '韩青',
  '苏简',
  '何雨',
  '魏川',
  '赵宁',
  '接口专家',
  '界面专家',
  '质量专家',
  '数据专家',
];
const roles = [
  '后端开发，负责订单接口、字段映射和兼容性',
  '产品负责人，确认业务规则与交付范围',
  '财务代表，核对字段口径与数据使用范围',
  '质量负责人，组织独立测试和复核',
];
export const uxParticipants = names.map((name, index) => ({
  id: `ux1-member-${index}`,
  name,
  kind: index < 18 ? 'human' : 'expert',
  role:
    index < 18
      ? roles[index % roles.length]
      : [
          '接口实现与契约分析',
          'React 界面、键盘操作与可访问性',
          '独立回归、边界条件和权限评审',
          '数据映射、迁移分析与一致性校验',
        ][index - 18],
  capabilities:
    index < 18
      ? ['需求确认', '团队协作']
      : [
          ['接口分析', '后端实现'],
          ['React', '无障碍'],
          ['独立测试', '评审'],
          ['数据分析', '校验'],
        ][index - 18],
  instructions: '仅用于 UI 验证的模拟成员，不授予系统权限。',
  available: true,
}));
const titles = [
  '确认采购订单筛选、数据导出及敏感字段处理范围',
  '梳理已有接口与数据约定，冻结前后端交付契约',
  '实现订单检索、筛选及大批量导出接口',
  '实现采购工作台与订单列表，补齐空态、错误和键盘操作',
  '检查角色权限及敏感字段脱敏，输出可复核矩阵',
  '准备历史订单字段映射、迁移与回滚说明',
  '联合验证前后端接口、异常分支与历史调用方兼容性',
  '验证大数据量导出的性能与失败恢复',
  '完成产品验收并逐项核对评审修改结果',
  '整理版本交付说明、操作手册及后续问题清单',
];
const dependencies = [[], [0], [1], [1], [1], [1], [2, 3, 4, 5], [2, 5], [6, 7], [8]];
const positions = [
  [0, 0],
  [320, 0],
  [640, -285],
  [640, -95],
  [640, 95],
  [640, 285],
  [960, -95],
  [960, 180],
  [1280, 0],
  [1600, 0],
];
export const uxTask = {
  id: 'ux1-task',
  projectId: uxProject.id,
  title: '采购订单全链路升级：多角色协作、并行交付与历史数据兼容验证',
  goal: '升级企业采购门户的订单工作台，支持状态筛选、跨部门协作与导出。复用已有登录和订单接口，保留历史调用方兼容性。销售、财务和采购角色读取不同字段，所有导出沿用界面筛选条件。手机号与付款账户按角色脱敏，非必填字段保持空值并保留原始记录。交付包含界面、接口说明、权限矩阵、迁移方案、独立测试报告和操作手册。当前仅编排交付工作，不执行生产发布。各并行节点需在接口契约完成后启动，联合验证完成后才能进入产品验收。此任务为明确标注的 UX 验证数据。',
  participantIds: uxParticipants.map((p) => p.id),
  status: 'draft',
  updatedAt: '2026-10-22T10:00:00.000Z',
  workflows: [
    {
      id: 'ux1-workflow',
      name: '主工作流',
      parentNodeId: null,
      nodes: titles
        .map((title, index) => ({
          id: `ux1-node-${index}`,
          title,
          description: `${title}。参考已确认的上游产物，明确输入、实现范围、异常情况和交付负责人；需要跨团队决定的事项由负责人整理并提交评审，不把待确认事项视为已批准。`,
          assigneeId: uxParticipants[[1, 0, 18, 19, 20, 21, 20, 20, 1, 0][index]].id,
          reviewerIds:
            index === 0 ? ['ux1-member-0', 'ux1-member-20'] : ['ux1-member-1', 'ux1-member-2'],
          reviewRequired: index !== 8,
          dependsOn: dependencies[index].map((i) => `ux1-node-${i}`),
          skillIds: [],
          mcpIds: [],
          input:
            index === 0
              ? '任务目标、项目背景与角色分工'
              : '前序节点已确认的文字说明和版本化交付材料',
          output: `${title}的交付文件、关键决定及验证记录。标明完成项、待处理项和复核依据，便于下一节点直接读取。`,
          rationale: '根据责任边界分配给相应人员或专家，保留独立评审。',
          position: { x: positions[index][0], y: positions[index][1] },
        }))
        .map((node) => ({
          ...node,
          reviewerIds: node.reviewRequired
            ? node.reviewerIds.filter((id) => id !== node.assigneeId)
            : [],
        })),
    },
  ],
};
export const uxCommands = [
  { type: 'save-project', project: uxProject },
  ...uxParticipants.map((participant) => ({ type: 'save-participant', participant })),
  { type: 'save-task', task: uxTask },
];
