/** Public business cases. Expected candidates are retrieval checks, not model-quality scores. */
export const planningScenarios = [
  {
    id: 'csv-import',
    goal: '导入 CSV，预览缺失字段并确认映射规则',
    resource: 'CSV 字段映射',
    kind: 'skill',
  },
  {
    id: 'report-privacy',
    goal: '报表导出增加敏感字段脱敏，财务确认可见范围',
    resource: '敏感字段脱敏',
    kind: 'skill',
  },
  { id: 'login-api', goal: '设计账号登录 API 与错误响应', resource: 'API 接口约定', kind: 'skill' },
  { id: 'research', goal: '研究公开市场数据并整理来源', resource: '公开市场数据', kind: 'mcp' },
  {
    id: 'prototype',
    goal: '制作采购审批界面原型，检查交互',
    resource: '界面原型设计',
    kind: 'skill',
  },
  { id: 'release', goal: '准备版本发布清单与回滚说明', resource: '版本发布清单', kind: 'template' },
  { id: 'copy-edit', goal: '校对一段帮助文案', resource: '文案校对', kind: 'skill' },
  {
    id: 'parallel-api-sdk',
    goal: '并行开发订单 API、SDK 和 Web，再集成验证',
    resource: 'SDK 开发与集成',
    kind: 'skill',
  },
];
