import type {
  comparePlanningWorkflows,
  PlanningNodeField,
  Workbench,
  Workflow,
  WorkNode,
} from '@zhuma/agent-core';
import { Button } from './Button.js';

const fieldNames: Record<PlanningNodeField, string> = {
  title: '节点名称',
  description: '工作说明',
  assigneeId: '执行者',
  reviewRequired: '完成后评审',
  reviewerIds: '评审人',
  skillIds: 'Skills',
  mcpIds: 'MCP',
  input: '输入材料',
  output: '交付内容',
  rationale: '分工依据',
  dependsOn: '前置依赖',
  position: '画布位置',
};

export function PlanningChanges({
  changes,
  before,
  after,
  state,
  baselineLabel,
  locate,
}: {
  changes: ReturnType<typeof comparePlanningWorkflows>;
  before: readonly Workflow[];
  after: readonly Workflow[];
  state: Workbench;
  baselineLabel: string;
  locate(workflowId: string, nodeId: string | null, original: boolean): void;
}) {
  const person = (id: string | null) =>
    id === null
      ? '未分配'
      : (state.participants.find((p) => p.id === id)?.name ?? `不可用成员（${id}）`);
  const nodeName = (id: string, flows: readonly Workflow[]) =>
    flows.flatMap((w) => w.nodes).find((n) => n.id === id)?.title ?? id;
  function value(node: WorkNode, field: PlanningNodeField, flows: readonly Workflow[]): string {
    switch (field) {
      case 'assigneeId':
        return person(node.assigneeId);
      case 'reviewRequired':
        return node.reviewRequired ? '需要评审' : '不需要评审';
      case 'reviewerIds':
        return node.reviewerIds.map(person).join('、') || '未选择';
      case 'skillIds':
      case 'mcpIds':
        return (
          node[field]
            .map((id) => state.assets.find((a) => a.id === id)?.name ?? `不可用资源（${id}）`)
            .join('、') || '未选择'
        );
      case 'dependsOn':
        return node.dependsOn.map((id) => nodeName(id, flows)).join('、') || '无';
      case 'position':
        return `${node.position.x}, ${node.position.y}`;
      default:
        return node[field] || '未填写';
    }
  }
  const values = (old: string, next: string) => (
    <div className="zm-change-values">
      <div>
        <small>调整前</small>
        <p>{old}</p>
      </div>
      <div>
        <small>调整后</small>
        <p>{next}</p>
      </div>
    </div>
  );
  return (
    <section className="zm-plan-changes" aria-label="变更预览">
      <h4>变更预览</h4>
      <p className="zm-change-caption">与{baselineLabel}比较 · 应用后才保存</p>
      {!changes.changed && <p className="zm-muted">工作流没有变化</p>}
      {changes.changed && (
        <p className="zm-change-counts" aria-label="节点变更统计">
          <span>新增 {changes.nodes.filter((n) => n.kind === 'added').length}</span>
          <span>修改 {changes.nodes.filter((n) => n.kind === 'changed').length}</span>
          <span>删除 {changes.nodes.filter((n) => n.kind === 'removed').length}</span>
        </p>
      )}
      {changes.orderChanged && <p className="zm-muted">工作流顺序有调整</p>}
      {changes.workflows.map((change) => {
        const workflow = change.kind === 'removed' ? change.before : change.after;
        return (
          <details className="zm-change-entry" key={`workflow-${workflow.id}`}>
            <summary>
              {change.kind === 'added'
                ? '新增工作流'
                : change.kind === 'removed'
                  ? '删除工作流'
                  : '调整工作流'}{' '}
              · {workflow.name}
            </summary>
            {change.kind === 'changed' ? (
              change.fields.map((field) => (
                <div key={field}>
                  <strong>
                    {field === 'name' ? '名称' : field === 'parentNodeId' ? '所属节点' : '节点顺序'}
                  </strong>
                  {values(
                    field === 'nodeOrder'
                      ? change.before.nodes.map((n) => n.title).join(' → ') || '空工作流'
                      : field === 'parentNodeId'
                        ? change.before.parentNodeId
                          ? nodeName(change.before.parentNodeId, before)
                          : '主工作流'
                        : change.before.name,
                    field === 'nodeOrder'
                      ? change.after.nodes.map((n) => n.title).join(' → ') || '空工作流'
                      : field === 'parentNodeId'
                        ? change.after.parentNodeId
                          ? nodeName(change.after.parentNodeId, after)
                          : '主工作流'
                        : change.after.name,
                  )}
                </div>
              ))
            ) : (
              <p>{workflow.nodes.length} 个节点</p>
            )}
            <Button
              variant="quiet"
              onClick={() => locate(workflow.id, null, change.kind === 'removed')}
            >
              定位工作流
            </Button>
          </details>
        );
      })}
      {changes.nodes.map((change) => {
        const node = change.kind === 'removed' ? change.before : change.after;
        const flows = change.kind === 'removed' ? before : after;
        const fields =
          change.kind === 'changed'
            ? change.fields
            : [
                ...(['assigneeId', 'output'] as const),
                ...(node.skillIds.length ? (['skillIds'] as const) : []),
                ...(node.mcpIds.length ? (['mcpIds'] as const) : []),
              ];
        return (
          <details
            className={`zm-change-entry ${change.kind}`}
            key={`${change.workflowId}/${node.id}`}
            open={changes.nodes.length <= 3}
          >
            <summary>
              <span className="zm-change-kind">
                {change.kind === 'added' ? '新增' : change.kind === 'removed' ? '删除' : '修改'}
              </span>
              <span>{node.title}</span>
            </summary>
            <div className="zm-change-location">
              <span>{flows.find((w) => w.id === change.workflowId)?.name}</span>
              <Button
                variant="quiet"
                onClick={() => locate(change.workflowId, node.id, change.kind === 'removed')}
              >
                {change.kind === 'removed' ? '查看原节点' : '定位节点'}
              </Button>
            </div>
            {fields.map((field) => (
              <div className="zm-change-field" key={field}>
                <strong>{fieldNames[field]}</strong>
                {change.kind === 'changed' ? (
                  values(value(change.before, field, before), value(change.after, field, after))
                ) : (
                  <p>{value(node, field, flows)}</p>
                )}
              </div>
            ))}
          </details>
        );
      })}
    </section>
  );
}
