// Public display data shared by browser and isolated desktop checks.
export function prepareExpertLibrary(state) {
  const qa = state.participants.find((participant) => participant.id === 'qa');
  const frontend = state.participants.find((participant) => participant.id === 'frontend');
  Object.assign(qa, {
    role: '质量与验收',
    capabilities: ['回归验证', '接口核对', '异常定位'],
    instructions:
      '依据当前任务和实际代码核对接口、界面与数据一致性。\n\n先确认输入和已接受的交付版本，再记录复现步骤、验证环境与结果。发现异常时指出具体位置和用户影响；尚未执行的检查保持待验证，不把建议写成通过。',
    resourceBindings: { skillIds: ['skill-0'], mcpIds: ['docs-mcp'] },
  });
  Object.assign(frontend, {
    role: '界面实现',
    capabilities: ['交互设计', '组件实现', '可用性'],
    instructions:
      '沿用项目现有组件与样式实现界面。\n\n核对用户目标、当前状态和下一步操作，覆盖空、加载、失败与窄窗口。提交可追溯的改动与实际验证结果。',
  });
  state.assets.push({
    id: 'docs-mcp',
    name: '接口文档查询',
    kind: 'mcp',
    description: '公开接口文档检索定义，未认证运行连接。',
    content: '仅在获得运行授权与可用连接时查询文档。',
    available: false,
  });
  return state;
}
