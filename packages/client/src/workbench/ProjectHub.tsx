import { useState } from 'react';
import type { Project, Workbench, WorkTask } from '@zhuma/agent-core';
import { Button } from './Button.js';
import { Field, MultiSelect, ParticipantSelect } from './controls.js';
import { ControlIcon } from './ControlIcon.js';
import { ProjectArtifactsPanel } from './ProjectArtifactsPanel.js';
import type { ExecutionApi } from '../execution/ExecutionApi.js';
import { TaskProgressSummary } from '../execution/TaskProgressSummary.js';
import type { TaskProgressState } from '../execution/useTaskProgress.js';
import { ProjectKnowledgePanel } from '../knowledge/ProjectKnowledgePanel.js';
import type { ProjectKnowledgePanelProps } from '../knowledge/project-knowledge-api.js';

export type ProjectTab = 'overview' | 'work' | 'materials' | 'people';
const tabs: Record<ProjectTab, string> = {
  overview: '概览',
  work: '工作',
  materials: '资料与成果',
  people: '成员',
};
const assetKind = { skill: 'Skill', mcp: 'MCP', template: '工作流' };

/** Project defaults seed future drafts; they are neither grants nor runtime assignments. */
export function defaultProjectParticipants(
  project: Project | undefined,
  state: Workbench,
): string[] {
  return [
    ...(project?.defaultParticipantIds ??
      state.participants.filter((p) => p.available).map((p) => p.id)),
  ];
}

export function ProjectFields({
  project,
  state,
  change,
}: {
  project: Project;
  state: Workbench;
  change(project: Project): void;
}) {
  return (
    <>
      <Field label="项目名称">
        <input
          required
          autoFocus
          maxLength={160}
          value={project.name}
          onChange={(e) => change({ ...project, name: e.target.value })}
        />
      </Field>
      <Field label="背景与目标">
        <textarea
          rows={4}
          maxLength={8000}
          value={project.description}
          onChange={(e) => change({ ...project, description: e.target.value })}
        />
      </Field>
      <ParticipantSelect
        label="默认参与者"
        multiple
        members={state.participants}
        selected={defaultProjectParticipants(project, state)}
        hint="新任务默认加入，可在创建时调整；不改变已有任务和访问权限。"
        change={(defaultParticipantIds) => change({ ...project, defaultParticipantIds })}
      />
      <MultiSelect
        label="关联资产"
        options={state.assets.map((a) => ({
          id: a.id,
          name: `${a.name} · ${assetKind[a.kind]}${a.available ? '' : ' · 已停用'}`,
        }))}
        selected={project.assetIds ?? []}
        change={(assetIds) => change({ ...project, assetIds })}
      />
      <section className="zm-project-links-editor" aria-label="参考链接">
        <header>
          <h3>参考链接</h3>
          <Button
            disabled={(project.references?.length ?? 0) >= 30}
            onClick={() =>
              change({
                ...project,
                references: [
                  ...(project.references ?? []),
                  { id: crypto.randomUUID(), name: '', url: '' },
                ],
              })
            }
          >
            添加链接
          </Button>
        </header>
        {(project.references ?? []).map((reference, index) => (
          <div className="zm-project-link-fields" key={reference.id}>
            <Field label={`链接名称 ${index + 1}`}>
              <input
                required
                maxLength={160}
                value={reference.name}
                onChange={(e) =>
                  change({
                    ...project,
                    references: project.references!.map((r) =>
                      r.id === reference.id ? { ...r, name: e.target.value } : r,
                    ),
                  })
                }
              />
            </Field>
            <Field label={`链接地址 ${index + 1}`}>
              <input
                required
                type="url"
                maxLength={2000}
                placeholder="https://…"
                value={reference.url}
                onChange={(e) =>
                  change({
                    ...project,
                    references: project.references!.map((r) =>
                      r.id === reference.id ? { ...r, url: e.target.value } : r,
                    ),
                  })
                }
              />
            </Field>
            <Button
              aria-label={`移除链接 ${index + 1}`}
              variant="quiet"
              onClick={() =>
                change({
                  ...project,
                  references: project.references!.filter((r) => r.id !== reference.id),
                })
              }
            >
              移除
            </Button>
          </div>
        ))}
        {!project.references?.length && (
          <p className="zm-project-muted">关联需求、设计或接口文档，供项目工作参考。</p>
        )}
      </section>
    </>
  );
}

export function ProjectHub({
  project,
  state,
  tab,
  changeTab,
  openTask,
  createTask,
  edit,
  canCreateTask = true,
  canEdit = true,
  resourcesConnected = true,
  projectExecution,
  spaceId,
  taskProgress,
  knowledge,
}: {
  project: Project;
  state: Workbench;
  tab: ProjectTab;
  changeTab(tab: ProjectTab): void;
  openTask(id: string): void;
  createTask(): void;
  edit(): void;
  canCreateTask?: boolean;
  canEdit?: boolean;
  resourcesConnected?: boolean;
  projectExecution?: Pick<ExecutionApi, 'files' | 'projectArtifacts'> | undefined;
  spaceId?: string | undefined;
  taskProgress?: ((taskId: string) => TaskProgressState | undefined) | undefined;
  knowledge?: ProjectKnowledgePanelProps | undefined;
}) {
  const [search, setSearch] = useState('');
  const tasks = state.tasks
    .filter((t) => t.projectId === project.id)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const matchingTasks = tasks.filter((t) =>
    `${t.title} ${t.goal}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const defaults = defaultProjectParticipants(project, state);
  const people = state.participants.filter((p) => defaults.includes(p.id));
  const others = state.participants.filter(
    (p) => !defaults.includes(p.id) && tasks.some((t) => t.participantIds.includes(p.id)),
  );
  const assets = state.assets.filter((a) => project.assetIds?.includes(a.id));
  const references = project.references ?? [];
  function workList(items: WorkTask[]) {
    return (
      <div className="zm-project-work-list">
        {items.map((task) => (
          <button type="button" key={task.id} onClick={() => openTask(task.id)}>
            <span>
              <strong>{task.title}</strong>
              <small>
                {state.participants.find((p) => p.id === task.ownerId)?.name ?? '负责人待定'} ·{' '}
                {task.workflows.flatMap((w) => w.nodes).length} 个节点
              </small>
            </span>
            <span className="zm-task-state-cell">
              <TaskProgressSummary
                progress={taskProgress?.(task.id)}
                confirmed={state.appliedPlans.some((plan) => plan.taskId === task.id)}
                compact
              />
              <span className={`zm-badge ${task.status}`}>
                {task.status === 'ready' ? '计划已确认' : '计划草稿'}
              </span>
            </span>
            <ControlIcon direction="right" />
          </button>
        ))}
      </div>
    );
  }
  function peopleList(ids: string[]) {
    return (
      <ul className="zm-project-people">
        {state.participants
          .filter((p) => ids.includes(p.id))
          .map((p) => {
            const avatarLabel = `${p.name} · ${p.kind === 'expert' ? 'Agent 专家' : '团队成员'}（参与者）`;
            return (
              <li key={p.id}>
                <span
                  className={`zm-avatar ${p.kind}`}
                  role="img"
                  title={avatarLabel}
                  aria-label={avatarLabel}
                >
                  {p.kind === 'expert' ? 'AI' : p.name.slice(0, 1)}
                </span>
                <span>
                  <strong>{p.name}</strong>
                  <small>
                    {p.kind === 'expert' ? 'Agent 专家' : '团队成员'}
                    {p.role ? ` · ${p.role}` : ''}
                  </small>
                </span>
                {!p.available && <small>已停用</small>}
              </li>
            );
          })}
      </ul>
    );
  }
  return (
    <section className="zm-project-hub" aria-label="项目详情">
      <nav className="zm-tabs zm-project-tabs" aria-label="项目导航">
        {(Object.keys(tabs) as ProjectTab[]).map((key) => (
          <button
            type="button"
            key={key}
            aria-current={key === tab ? 'page' : undefined}
            onClick={() => changeTab(key)}
          >
            {tabs[key]}
          </button>
        ))}
      </nav>
      {tab === 'overview' && (
        <>
          <p className="zm-project-description">{project.description || '尚未填写项目背景。'}</p>
          <div className="zm-project-overview">
            <section className="zm-project-panel">
              <header>
                <h2>
                  最近更新的工作 <small>{tasks.length}</small>
                </h2>
                <Button variant="quiet" onClick={() => changeTab('work')}>
                  查看全部
                </Button>
              </header>
              {tasks.length ? (
                workList(tasks.slice(0, 5))
              ) : (
                <div className="zm-project-empty">
                  <p>从项目目标开始一项工作。</p>
                  <Button disabled={!canCreateTask} onClick={createTask}>
                    创建任务
                  </Button>
                </div>
              )}
            </section>
            <aside>
              <section className="zm-project-panel">
                <header>
                  <h2>
                    默认参与者 <small>{people.length}</small>
                  </h2>
                  <Button variant="quiet" onClick={() => changeTab('people')}>
                    管理
                  </Button>
                </header>
                {people.length ? (
                  peopleList(people.slice(0, 4).map((p) => p.id))
                ) : (
                  <p className="zm-project-muted">尚未选择真人或专家。</p>
                )}
                {people.length > 4 && (
                  <Button variant="quiet" onClick={() => changeTab('people')}>
                    查看全部 {people.length} 位
                  </Button>
                )}
              </section>
              <section className="zm-project-panel">
                <header>
                  <h2>项目资料</h2>
                  <Button variant="quiet" onClick={() => changeTab('materials')}>
                    查看
                  </Button>
                </header>
                <p className="zm-project-muted">
                  {references.length} 个参考链接 · {assets.length} 项关联资产
                </p>
                {!!references.length && (
                  <ul className="zm-project-links">
                    {references.slice(0, 3).map((r) => (
                      <li key={r.id}>
                        <a href={r.url} target="_blank" rel="noreferrer">
                          {r.name} ↗
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </aside>
          </div>
        </>
      )}
      {tab === 'work' && (
        <section className="zm-project-panel">
          <header>
            <h2>
              项目工作 <small>{tasks.length}</small>
            </h2>
            <input
              type="search"
              aria-label="搜索项目工作"
              placeholder="搜索项目工作…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </header>
          {matchingTasks.length ? (
            workList(matchingTasks)
          ) : (
            <div className="zm-project-empty">
              <p>{tasks.length ? '没有匹配的工作。' : '项目中还没有任务。'}</p>
              <Button
                disabled={!tasks.length && !canCreateTask}
                onClick={() => (tasks.length ? setSearch('') : createTask())}
              >
                {tasks.length ? '清除搜索' : '创建任务'}
              </Button>
            </div>
          )}
        </section>
      )}
      {tab === 'materials' && (
        <div className="zm-project-materials">
          {knowledge && <ProjectKnowledgePanel {...knowledge} />}
          {projectExecution?.projectArtifacts && spaceId ? (
            <ProjectArtifactsPanel
              spaceId={spaceId}
              projectId={project.id}
              api={projectExecution.projectArtifacts}
              filesApi={projectExecution}
              openTask={openTask}
            />
          ) : (
            <section className="zm-project-panel">
              <header>
                <h2>已接受成果</h2>
              </header>
              <p className="zm-project-muted">成果查询尚未接通。</p>
            </section>
          )}
          {!references.length && !assets.length && (
            <section className="zm-project-panel">
              <header>
                <h2>
                  参考链接与资产 <small>{resourcesConnected ? '未添加' : '团队资产尚未接入'}</small>
                </h2>
                <Button disabled={!canEdit} onClick={edit}>
                  管理资料
                </Button>
              </header>
            </section>
          )}
          {!!references.length && (
            <section className="zm-project-panel">
              <header>
                <h2>
                  参考链接 <small>{references.length}</small>
                </h2>
                <Button disabled={!canEdit} onClick={edit}>
                  管理资料
                </Button>
              </header>
              <ul className="zm-project-links">
                {references.map((r) => (
                  <li key={r.id}>
                    <a href={r.url} target="_blank" rel="noreferrer">
                      {r.name} ↗
                    </a>
                    <small>{r.url}</small>
                  </li>
                ))}
              </ul>
              <p className="zm-project-muted">AI 规划可读取链接名称和地址，不会自动抓取正文。</p>
            </section>
          )}
          {!!assets.length && (
            <section className="zm-project-panel">
              <header>
                <h2>
                  关联资产 <small>{assets.length}</small>
                </h2>
                {!references.length && (
                  <Button disabled={!canEdit} onClick={edit}>
                    管理资料
                  </Button>
                )}
              </header>
              <ul className="zm-project-assets">
                {assets.map((a) => (
                  <li key={a.id}>
                    <span>
                      <strong>{a.name}</strong>
                      <small>{a.description || assetKind[a.kind]}</small>
                    </span>
                    <span>
                      {assetKind[a.kind]}
                      {!a.available && ' · 已停用'}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {!!references.length && !assets.length && !resourcesConnected && (
            <section className="zm-project-panel">
              <header>
                <h2>
                  关联资产 <small>团队资产尚未接入</small>
                </h2>
              </header>
            </section>
          )}
        </div>
      )}
      {tab === 'people' && (
        <div className="zm-project-materials">
          <section className="zm-project-panel">
            <header>
              <h2>
                默认参与者 <small>{people.length}</small>
              </h2>
              <Button disabled={!canEdit} onClick={edit}>
                更改默认参与者
              </Button>
            </header>
            <p className="zm-project-muted">
              新任务默认加入，可在创建时调整；不改变已有任务和访问权限。
            </p>
            {people.length ? (
              peopleList(defaults)
            ) : (
              <p className="zm-project-muted">尚未选择真人或专家。</p>
            )}
          </section>
          {!!others.length && (
            <section className="zm-project-panel">
              <header>
                <h2>
                  任务中的其他参与者 <small>{others.length}</small>
                </h2>
              </header>
              <p className="zm-project-muted">保留各任务已有的分工。</p>
              {peopleList(others.map((p) => p.id))}
            </section>
          )}
        </div>
      )}
    </section>
  );
}
