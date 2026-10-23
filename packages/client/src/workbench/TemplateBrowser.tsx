import { useMemo, useState } from 'react';
import { parseWorkflowTemplate, type TeamAsset, type WorkflowTemplate } from '@zhuma/agent-core';
import { Modal } from './controls.js';
import { Button } from './Button.js';
import { TemplatePreview } from './TemplatePreview.js';

export function TemplateBrowser({
  assets,
  selectedId,
  choose,
  close,
}: {
  assets: TeamAsset[];
  selectedId: string | null;
  choose(asset: TeamAsset): void;
  close(): void;
}) {
  const [search, setSearch] = useState('');
  const [activeId, setActiveId] = useState(selectedId);
  const templates = useMemo(
    () =>
      assets
        .filter((a) => a.kind === 'template')
        .map((asset) => {
          let definition: WorkflowTemplate | null = null;
          try {
            definition = parseWorkflowTemplate(asset.content);
          } catch {
            /* Legacy text remains visible but cannot be applied. */
          }
          return { asset, definition };
        }),
    [assets],
  );
  const matches = templates.filter(({ asset }) =>
    `${asset.name} ${asset.description}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const selected = matches.find(({ asset }) => asset.id === activeId) ?? matches[0];
  return (
    <Modal title="选择工作流" close={close}>
      <div className="zm-template-browser">
        <aside className="zm-template-library">
          <input
            autoFocus
            aria-label="搜索工作流"
            placeholder="搜索名称或用途"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <ul aria-label="当前空间工作流">
            {matches.map(({ asset, definition }) => (
              <li key={asset.id}>
                <button
                  type="button"
                  aria-current={selected?.asset.id === asset.id ? 'true' : undefined}
                  onClick={() => setActiveId(asset.id)}
                >
                  <strong>{asset.name}</strong>
                  <small>{asset.description || '工作流模板'}</small>
                  <span>
                    {!asset.available
                      ? '已停用'
                      : definition
                        ? `${definition.workflows.flatMap((w) => w.nodes).length} 个节点 · ${definition.roles.length} 个角色`
                        : '文字模板 · 需转换'}
                  </span>
                </button>
              </li>
            ))}
            {!matches.length && (
              <li className="zm-empty-inline">
                {templates.length
                  ? '没有匹配的工作流'
                  : '还没有工作流，可从任务中保存，或在团队资产中新建。'}
              </li>
            )}
          </ul>
        </aside>
        <div className="zm-template-library-detail">
          {selected?.definition ? (
            <>
              <header>
                <h3>{selected.asset.name}</h3>
                <p>{selected.asset.description}</p>
              </header>
              <TemplatePreview key={selected.asset.id} definition={selected.definition} />
            </>
          ) : (
            <div className="zm-empty-inline">
              {selected ? (
                <>
                  <h3>{selected.asset.name}</h3>
                  <p>此模板尚未包含可复用的节点和依赖，请在团队资产中转换后使用。</p>
                </>
              ) : (
                '选择工作流预览节点、角色和交付内容。'
              )}
            </div>
          )}
        </div>
      </div>
      <footer>
        <Button onClick={close}>取消</Button>
        <Button
          variant="primary"
          disabled={!selected?.definition || !selected.asset.available}
          onClick={() => selected && choose(selected.asset)}
        >
          使用此工作流
        </Button>
      </footer>
    </Modal>
  );
}
