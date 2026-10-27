// Public response replay; not stored files, live permissions or accepted-work evidence.
export function upstreamInputs() {
  return [
    {
      access: 'visible',
      blocking: false,
      sourceNodeId: 'api-contract',
      artifactVersionId: 'artifact:accept-api-contract-v2',
      sourceGoal: '确认订单接口与错误码',
      version: 2,
      name: '第 2 版',
    },
    {
      access: 'pending',
      blocking: false,
      pending: 'none',
      sourceNodeId: 'help-copy',
      message: '上游节点 help-copy 尚无已接受版本。',
    },
    {
      access: 'pending',
      blocking: false,
      pending: 'replaced',
      sourceNodeId: 'page-design',
      message: '上游节点 page-design 已有新的已接受版本，当前引用的版本已被取代。',
    },
    { access: 'hidden', blocking: true, count: 2, message: '有 2 个上游来源你没有权限查看。' },
  ];
}
