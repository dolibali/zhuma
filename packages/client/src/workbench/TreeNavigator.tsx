import { useState, type CSSProperties } from 'react';
import { nodeRelations, workflowPath, type WorkTree } from './navigation.js';
import type { WorkNode, Workflow } from '@zhuma/agent-core';
import { ControlIcon } from './ControlIcon.js';

export function TreeNavigator({
  tree,
  workflow,
  selectedId,
  expanded,
  toggle,
  expandAll,
  select,
  enter,
}: {
  tree: WorkTree;
  workflow: Workflow;
  selectedId: string | null;
  expanded: ReadonlySet<string>;
  toggle(id: string): void;
  expandAll(): void;
  select(id: string): void;
  enter(id: string): void;
}) {
  const [query, setQuery] = useState('');
  const selected = selectedId ? tree.nodes.get(selectedId) : undefined;
  const path = workflowPath(tree, workflow.id);
  const activePath = new Set(path.map((w) => w.id));
  const { before, after } = nodeRelations(tree, selectedId);
  const terms = query.trim().toLocaleLowerCase();
  const results = terms
    ? [...tree.nodes.values()].filter((n) => {
        const owner = tree.owner.get(n.id)!;
        return `${n.title} ${workflowPath(tree, owner.id)
          .map((w) => w.name)
          .join(' ')}`
          .toLocaleLowerCase()
          .includes(terms);
      })
    : [];
  const nodeButton = (n: WorkNode) => (
    <button
      className="zm-tree-item"
      aria-label={`定位 ${n.title}`}
      aria-current={n.id === selectedId ? 'location' : undefined}
      onClick={() => select(n.id)}
    >
      <span>{n.title}</span>
      {n.id === selectedId && <small>当前</small>}
    </button>
  );
  function branch(w: Workflow, depth: number) {
    return (
      <ul className="zm-tree-branch" aria-label={w.name}>
        {w.nodes.map((n) => {
          const child = tree.child.get(n.id);
          return (
            <li key={n.id}>
              <div className="zm-tree-row" style={{ '--tree-depth': depth } as CSSProperties}>
                {child ? (
                  <button
                    className="zm-tree-toggle"
                    aria-expanded={expanded.has(child.id)}
                    aria-label={`${expanded.has(child.id) ? '折叠' : '展开'} ${n.title}`}
                    disabled={activePath.has(child.id)}
                    title={activePath.has(child.id) ? '当前定位位于此分支' : undefined}
                    onClick={() => toggle(child.id)}
                  >
                    <ControlIcon direction={expanded.has(child.id) ? 'down' : 'right'} />
                  </button>
                ) : (
                  <span className="zm-tree-leaf" aria-hidden="true">
                    ·
                  </span>
                )}
                {nodeButton(n)}
              </div>
              {child && expanded.has(child.id) && branch(child, depth + 1)}
            </li>
          );
        })}
        {!w.nodes.length && <li className="zm-tree-empty">暂无工作节点</li>}
      </ul>
    );
  }
  const relations = (label: string, nodes: WorkNode[]) => (
    <div className="zm-tree-relations">
      <small>{label}</small>
      {nodes.length ? (
        nodes.map((n) => (
          <button key={n.id} onClick={() => select(n.id)}>
            {n.title} <ControlIcon direction="right" />
          </button>
        ))
      ) : (
        <span>无</span>
      )}
    </div>
  );
  return (
    <div className="zm-tree-navigator">
      <div className="zm-tree-selection" aria-label="当前定位">
        <small>当前定位 · 第 {path.length} 层</small>
        <strong>{selected?.title ?? workflow.name}</strong>
        <span>{path.map((w) => w.name).join(' / ')}</span>
        <div className="zm-actions">
          <button onClick={() => enter(workflow.id)}>进入本层工作流</button>
          {selected && tree.child.has(selected.id) && (
            <button onClick={() => enter(tree.child.get(selected.id)!.id)}>
              打开子工作流 <ControlIcon direction="right" />
            </button>
          )}
        </div>
        {selected && (
          <details className="zm-tree-dependencies" open>
            <summary>
              直接依赖{' '}
              <small>
                {before.length} 前置 · {after.length} 后续
              </small>
            </summary>
            {relations('前置', before)}
            {relations('后续', after)}
          </details>
        )}
      </div>
      <div className="zm-tree-search">
        <input
          type="search"
          aria-label="搜索工作树"
          placeholder="搜索工作节点或层级"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="zm-tree-search-tools">
          <small>
            {terms
              ? `${results.length} 个结果`
              : `${tree.nodes.size} 个节点 · ${tree.workflows.size} 个工作流`}
          </small>
          {terms ? (
            <button onClick={() => setQuery('')}>清除搜索</button>
          ) : (
            <button onClick={expandAll}>展开全部</button>
          )}
        </div>
      </div>
      {terms ? (
        <ul className="zm-tree-results" aria-label="工作树搜索结果">
          {results.map((n) => (
            <li key={n.id}>
              {nodeButton(n)}
              <small>
                {workflowPath(tree, tree.owner.get(n.id)!.id)
                  .map((w) => w.name)
                  .join(' / ')}
              </small>
            </li>
          ))}
          {!results.length && <li className="zm-tree-empty">没有匹配的工作节点</li>}
        </ul>
      ) : (
        <nav aria-label="工作树层级">{branch(tree.root, 0)}</nav>
      )}
    </div>
  );
}
