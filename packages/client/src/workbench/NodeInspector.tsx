import type { Participant, Workbench, Workflow, WorkNode } from '@zhuma/agent-core';
import { ExpandableText, Field, MultiSelect, ParticipantSelect } from './controls.js';
import { ControlIcon } from './ControlIcon.js';
import { expertResources, selectExpertResources } from './expert-resources.js';

export function NodeInspector({
  node,
  workflow,
  members,
  state,
  readOnly,
  disabled,
  hasChild,
  update,
  manageMembers,
  split,
  remove,
  roleMode = false,
}: {
  node: WorkNode;
  workflow: Workflow;
  members: Participant[];
  state: Workbench;
  readOnly: boolean;
  disabled: boolean;
  hasChild: boolean;
  update(patch: Partial<WorkNode>): void;
  manageMembers(): void;
  split(): void;
  remove(): void;
  roleMode?: boolean;
}) {
  const assignee = members.find((m) => m.id === node.assigneeId);
  const names = (ids: string[]) =>
    ids.map((id) => members.find((m) => m.id === id)?.name ?? '不可用').join('、');
  const requiredResources = roleMode ? [] : expertResources(node, members, state.assets);
  const missingResources = requiredResources.filter(
    (resource) => !resource.selected || !resource.available,
  );
  const completedResources = selectExpertResources(node, members, state.assets);
  const canComplete =
    completedResources.skillIds.length > node.skillIds.length ||
    completedResources.mcpIds.length > node.mcpIds.length;
  if (readOnly)
    return (
      <div className="zm-node-summary">
        <div className="zm-node-identity">
          <span className={`zm-avatar ${assignee?.kind ?? 'human'}`}>
            {assignee?.kind === 'expert' ? 'AI' : (assignee?.name.slice(0, 1) ?? '—')}
          </span>
          <div>
            <strong>{assignee?.name ?? '未分配'}</strong>
            <small>{assignee?.kind === 'expert' ? 'Agent 专家' : '团队成员'}</small>
          </div>
        </div>
        <h3>{node.title}</h3>
        <p className="zm-prewrap">{node.description || '未填写工作说明'}</p>
        <section>
          <h4>交付内容</h4>
          <p className="zm-prewrap">{node.output || '尚未填写'}</p>
        </section>
        {node.input && (
          <section>
            <h4>输入材料</h4>
            <p className="zm-prewrap">{node.input}</p>
          </section>
        )}
        <section>
          <h4>评审要求</h4>
          <p>{node.reviewRequired ? `${names(node.reviewerIds)} · 需全员通过` : '无需评审'}</p>
        </section>
        {!!(node.skillIds.length + node.mcpIds.length) && (
          <section>
            <h4>能力</h4>
            <div className="zm-tags">
              {[...node.skillIds, ...node.mcpIds].map((id) => (
                <span key={id}>{state.assets.find((a) => a.id === id)?.name}</span>
              ))}
            </div>
          </section>
        )}
        {!!node.dependsOn.length && (
          <section>
            <h4>前置工作</h4>
            <ul>
              {node.dependsOn.map((id) => (
                <li key={id}>{workflow.nodes.find((n) => n.id === id)?.title}</li>
              ))}
            </ul>
          </section>
        )}
        {node.rationale && (
          <details>
            <summary>分工依据</summary>
            <p>{node.rationale}</p>
          </details>
        )}
        {hasChild && (
          <button onClick={split}>
            打开子工作流 <ControlIcon direction="right" />
          </button>
        )}
      </div>
    );
  return (
    <fieldset className="zm-config-form" disabled={disabled}>
      {hasChild && (
        <button className="zm-child-entry" onClick={split}>
          打开子工作流 <ControlIcon direction="right" />
        </button>
      )}
      <Field label="节点名称">
        <input
          maxLength={160}
          value={node.title}
          onChange={(e) => update({ title: e.target.value })}
        />
      </Field>
      <ParticipantSelect
        label={roleMode ? '执行角色' : '执行者'}
        roleMode={roleMode}
        members={members}
        selected={node.assigneeId ? [node.assigneeId] : []}
        change={(ids) =>
          update({
            assigneeId: ids[0] ?? null,
            reviewerIds: node.reviewerIds.filter((id) => id !== ids[0]),
            ...(!roleMode
              ? selectExpertResources(
                  { ...node, assigneeId: ids[0] ?? null },
                  members,
                  state.assets,
                )
              : {}),
          })
        }
      />
      <button className="zm-text-button" onClick={manageMembers}>
        {roleMode ? '管理模板角色' : '管理任务参与者'}
      </button>
      <ExpandableText
        label="要完成的工作"
        value={node.description}
        change={(description) => update({ description })}
      />
      <details className="zm-config-group" open>
        <summary>交付与输入</summary>
        <ExpandableText
          label="交付内容"
          value={node.output}
          change={(output) => update({ output })}
        />
        <ExpandableText label="输入材料" value={node.input} change={(input) => update({ input })} />
      </details>
      <div className="zm-review">
        <label>
          <input
            type="checkbox"
            checked={node.reviewRequired}
            onChange={(e) =>
              update({
                reviewRequired: e.target.checked,
                reviewerIds: e.target.checked ? node.reviewerIds : [],
              })
            }
          />
          完成后需要评审
        </label>
        {node.reviewRequired && (
          <ParticipantSelect
            label={roleMode ? '评审角色' : '评审人'}
            roleMode={roleMode}
            multiple
            hint="全部通过后交接"
            members={members.filter((m) => m.id !== node.assigneeId)}
            selected={node.reviewerIds}
            change={(reviewerIds) => update({ reviewerIds })}
          />
        )}
        {node.reviewRequired && !node.reviewerIds.length && (
          <small className="zm-warning">
            {roleMode
              ? '保存模板前，请选择至少一个评审角色。'
              : '确认工作流前，请选择至少一位评审人。'}
          </small>
        )}
      </div>
      <details className="zm-config-group" open={requiredResources.length > 0 ? true : undefined}>
        <summary>
          能力与依赖{' '}
          <span>
            {node.skillIds.length + node.mcpIds.length} 项能力 · {node.dependsOn.length} 项依赖
          </span>
        </summary>
        {!!requiredResources.length && (
          <div className="zm-field">
            <span className="zm-field-label">{assignee?.name} · 必需能力</span>
            <div className="zm-tags">
              {requiredResources.map((resource) => (
                <span key={`${resource.kind}-${resource.id}`}>
                  {resource.name}
                  {!resource.available ? ' · 不可用' : !resource.selected ? ' · 未选' : ''}
                </span>
              ))}
            </div>
            {!!missingResources.length && (
              <small className="zm-warning" role="status">
                必需能力未齐，补齐后才能确认工作流。
                {!canComplete &&
                assignee?.available &&
                missingResources.some((resource) => resource.available && !resource.selected)
                  ? '已达选择上限，请先移除其它能力。'
                  : ''}
              </small>
            )}
            {canComplete && (
              <button
                type="button"
                className="zm-text-button"
                onClick={() => update(completedResources)}
              >
                补齐必需能力
              </button>
            )}
          </div>
        )}
        <MultiSelect
          label="Skills"
          options={state.assets.filter(
            (a) => a.kind === 'skill' && (a.available || node.skillIds.includes(a.id)),
          )}
          selected={node.skillIds}
          change={(skillIds) => update({ skillIds })}
        />
        <MultiSelect
          label="MCP"
          options={state.assets.filter(
            (a) => a.kind === 'mcp' && (a.available || node.mcpIds.includes(a.id)),
          )}
          selected={node.mcpIds}
          change={(mcpIds) => update({ mcpIds })}
        />
        <MultiSelect
          label="前置依赖"
          options={workflow.nodes
            .filter((n) => n.id !== node.id)
            .map((n) => ({ id: n.id, name: n.title }))}
          selected={node.dependsOn}
          change={(dependsOn) => update({ dependsOn })}
        />
      </details>
      {node.rationale && (
        <details className="zm-rationale">
          <summary>分工依据</summary>
          <p>{node.rationale}</p>
        </details>
      )}
      <details className="zm-node-more">
        <summary>更多操作</summary>
        {!hasChild && <button onClick={split}>拆分为子工作流</button>}
        <button
          className="danger"
          disabled={hasChild}
          title={hasChild ? '先移除子工作流，再删除此节点' : undefined}
          onClick={remove}
        >
          删除节点
        </button>
      </details>
    </fieldset>
  );
}
