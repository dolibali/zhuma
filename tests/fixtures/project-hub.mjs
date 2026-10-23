/** Public, deterministic project data; no identity, run or accepted-artifact claims. */
export function prepareProjectHub(state) {
  state.participants = state.participants.slice(0, 4);
  state.assets = state.assets.slice(0, 3);
  Object.assign(state.assets[0], {
    name: '接口兼容规范',
    description: '输入输出、错误码与兼容约定。',
  });
  Object.assign(state.assets[1], {
    name: '交互检查清单',
    description: '检查空状态、键盘与错误恢复。',
  });
  Object.assign(state.assets[2], { name: '旧版说明', available: false });
  state.projects = [
    {
      id: 'project',
      name: '订单门户',
      description:
        '统一采购订单的查询与导出体验。\n业务和接口定义在项目内共享，任务分别保留负责人和评审分工。',
      defaultParticipantIds: ['chen', 'qa'],
      assetIds: ['skill-0', 'skill-2'],
      references: [
        {
          id: 'api-reference',
          name: 'HTTP 接口参考',
          url: 'https://developer.mozilla.org/en-US/docs/Web/HTTP',
        },
      ],
    },
    {
      id: 'research',
      name: '体验研究',
      description: '跨项目体验研究',
      defaultParticipantIds: ['lin', 'frontend'],
      assetIds: [],
    },
  ];
  state.tasks[0].participantIds = ['chen', 'qa', 'lin'];
  const second = structuredClone(state.tasks[0]);
  second.id = 'second-task';
  second.title = '订单导出字段核对';
  second.status = 'ready';
  second.updatedAt = '2026-10-22T01:00:00.000Z';
  state.tasks.push(second, {
    ...structuredClone(second),
    id: 'other-project-task',
    projectId: 'research',
    title: '研究列表空状态',
  });
  return state;
}
