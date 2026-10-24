import { createRoot } from 'react-dom/client';
import { createExecutionApi } from '../../src/execution/ExecutionApi.js';
import { DeliveryPanel } from '../../src/execution/DeliveryPanel.js';
import { InboxPanel } from '../../src/execution/InboxPanel.js';
import { ReviewWorkspace } from '../../src/execution/ReviewWorkspace.js';
import styles from '../../src/workbench/workbench.css';

const node = {
  nodeId: 'design',
  taskId: 'task',
  planId: 'plan',
  revision: 1,
  version: 2,
  status: 'in-review' as const,
  goal: '设计登录接口',
  expectedOutput: '接口说明与错误码',
  assigneeId: 'chen',
  reviewerIds: ['lin', 'outside'],
  currentRoundId: 'round-1',
  artifacts: [
    { id: 'artifact-1', version: 1, text: '登录接口接受邮箱和密码，错误时返回明确错误码。' },
  ],
  rounds: [
    {
      id: 'round-1',
      status: 'open',
      artifactVersionId: 'artifact-1',
      reviewerIds: ['lin', 'outside'],
      ballots: [{ reviewerId: 'lin', action: 'approve', comment: '错误码已经分开。' }],
    },
  ],
  comments: [],
};
const publish = {
  ...node,
  nodeId: 'publish',
  status: 'ready' as const,
  goal: '发布登录说明',
  currentRoundId: undefined,
  rounds: [],
  artifacts: [],
  reviewerIds: [],
};
const items = [
  {
    id: 'inbox-design',
    kind: 'review' as const,
    actorId: 'outside',
    nodeId: 'design',
    taskId: 'task',
    reason: 'review-assigned' as const,
    action: 'review' as const,
  },
  {
    id: 'inbox-publish',
    kind: 'deliver' as const,
    actorId: 'chen',
    nodeId: 'publish',
    taskId: 'task',
    reason: 'assignee-delivery' as const,
    action: 'submit' as const,
  },
];
const api = createExecutionApi({
  async call() {
    return {
      ok: false,
      error: { code: 'unavailable', message: '这是界面样例，不会提交。', details: {} },
    };
  },
});

const style = document.createElement('style');
style.textContent = styles;
document.head.append(style);
createRoot(document.getElementById('root')!).render(
  <div className="zhuma">
    <main className="zm-page">
      <InboxPanel
        items={items}
        nodes={[node, publish]}
        reload={() => undefined}
        open={() => undefined}
      />
      <DeliveryPanel api={api} node={publish} onSubmitted={() => undefined} />
      <ReviewWorkspace api={api} node={node} onSubmitted={() => undefined} />
    </main>
  </div>,
);
