import { useId } from 'react';
import type { Participant, TeamAsset } from '@zhuma/agent-core';
import { Button } from './Button.js';
import { SingleSelect } from './SingleSelect.js';

export type ExpertBrowserView = { search: string; role: string; selectedId: string | null };

export function ExpertBrowser({
  experts,
  assets,
  edit,
  source,
  view,
  change,
}: {
  experts: Participant[];
  assets: TeamAsset[];
  edit(expert: Participant): void;
  source(expert: Participant): void;
  view: ExpertBrowserView;
  change(view: ExpertBrowserView): void;
}) {
  const { search, role, selectedId } = view;
  const titleId = useId();
  const query = search.trim().toLocaleLowerCase();
  const matching = experts.filter(
    (expert) =>
      (!role || expert.role === role) &&
      `${expert.name} ${expert.role} ${expert.capabilities.join(' ')}`
        .toLocaleLowerCase()
        .includes(query),
  );
  const selected = matching.find((expert) => expert.id === selectedId) ?? matching[0];
  const status = (expert: Participant) =>
    expert.origin?.missing.length ? '待补齐' : expert.available ? '可参与' : '已停用';
  const bindings = (ids: string[] | undefined, kind: TeamAsset['kind']) =>
    ids?.map((id) => assets.find((asset) => asset.id === id && asset.kind === kind));
  return (
    <section className="zm-expert-browser" aria-label="专家目录">
      <div className="zm-expert-filter">
        <input
          type="search"
          aria-label="搜索专家"
          placeholder="搜索名称、职责或能力…"
          value={search}
          onChange={(event) => change({ ...view, search: event.target.value })}
        />
        <SingleSelect
          label="筛选专家职责"
          value={role}
          onValueChange={(role) => change({ ...view, role })}
          options={[
            { value: '', label: '全部职责' },
            ...[...new Set(experts.map((expert) => expert.role).filter(Boolean))]
              .sort((a, b) => a.localeCompare(b))
              .map((value) => ({ value, label: value })),
          ]}
        />
      </div>
      {!matching.length ? (
        <div className="zm-empty">
          <h3>{experts.length ? '没有匹配的专家' : '还没有专家'}</h3>
          <p>{experts.length ? '换个关键词，或清除筛选。' : '新建专家，或导入已有专家定义。'}</p>
          {!!experts.length && (
            <Button
              onClick={() => {
                change({ ...view, search: '', role: '' });
              }}
            >
              清除筛选
            </Button>
          )}
        </div>
      ) : (
        <div className="zm-expert-layout">
          <ul className="zm-expert-list" aria-label="选择专家">
            {matching.map((expert) => (
              <li key={expert.id}>
                <button
                  type="button"
                  aria-pressed={selected?.id === expert.id}
                  onClick={() => change({ ...view, selectedId: expert.id })}
                >
                  <span className="zm-avatar expert" aria-hidden>
                    AI
                  </span>
                  <span className="zm-expert-list-content">
                    <strong>{expert.name}</strong>
                    <small>{expert.role || '暂无职责说明'}</small>
                    <span>{status(expert)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {selected && (
            <section className="zm-expert-detail" aria-labelledby={titleId}>
              <header>
                <div>
                  <h2 id={titleId}>{selected.name}</h2>
                  <p>{selected.role || '暂无职责说明'}</p>
                </div>
                <Button onClick={() => edit(selected)}>编辑定义</Button>
              </header>
              <div className="zm-expert-detail-meta">
                <span>{status(selected)}</span>
                <span>
                  {selected.origin
                    ? selected.origin.sourceVersion
                      ? `来源版本 ${selected.origin.sourceVersion}`
                      : '导入定义'
                    : '本地定义'}
                </span>
                {selected.origin && (
                  <Button variant="quiet" onClick={() => source(selected)}>
                    查看来源
                  </Button>
                )}
              </div>
              {!!selected.capabilities.length && (
                <div className="zm-tags" aria-label="擅长的工作">
                  {selected.capabilities.map((capability) => (
                    <span key={capability}>{capability}</span>
                  ))}
                </div>
              )}
              {!!selected.origin?.missing.length && (
                <p className="zm-warning">
                  需补齐 {selected.origin.missing.length} 项来源或默认能力，当前不能启用。
                </p>
              )}
              <section>
                <h3>工作方法</h3>
                {selected.instructions ? (
                  <pre tabIndex={0}>{selected.instructions}</pre>
                ) : (
                  <p className="zm-muted">尚未填写工作方法。</p>
                )}
              </section>
              <section className="zm-expert-bindings">
                <h3>默认能力</h3>
                {(['skill', 'mcp'] as const).map((kind) => (
                  <div key={kind}>
                    <h4>{kind === 'skill' ? 'Skills' : 'MCP'}</h4>
                    <ul>
                      {bindings(
                        kind === 'skill'
                          ? selected.resourceBindings?.skillIds
                          : selected.resourceBindings?.mcpIds,
                        kind,
                      )?.map((asset, index) => (
                        <li key={index}>
                          {asset ? (
                            <>
                              {asset.name}
                              {!asset.available && <span className="zm-muted"> · 已停用</span>}
                            </>
                          ) : (
                            '定义已不可用'
                          )}
                        </li>
                      ))}
                      {!(kind === 'skill'
                        ? selected.resourceBindings?.skillIds.length
                        : selected.resourceBindings?.mcpIds.length) && (
                        <li className="zm-muted">未设置</li>
                      )}
                    </ul>
                  </div>
                ))}
              </section>
            </section>
          )}
        </div>
      )}
    </section>
  );
}
