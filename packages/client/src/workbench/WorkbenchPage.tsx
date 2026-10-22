import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  emptyWorkbench,
  type Workbench,
  type WorkTask,
  type Project,
  type Participant,
  type TeamAsset,
  type WorkbenchCommand,
} from '@zhuma/agent-core';
import type { WorkbenchApi } from './api.js';
import { Field, MemberPicker, Modal, ParticipantSelect } from './controls.js';
import { TaskEditor } from './TaskEditor.js';
import { Appearance, type AppearanceStore } from './Appearance.js';
import { Button } from './Button.js';

type Section = 'projects' | 'tasks' | 'assets' | 'members';
type Dialog =
  | { kind: 'project'; value: Project }
  | { kind: 'member'; value: Participant }
  | { kind: 'asset'; value: TeamAsset }
  | { kind: 'task'; value: WorkTask };
const uid = () => crypto.randomUUID();
const labels: Record<Section, string> = {
  projects: '项目',
  tasks: '任务清单',
  assets: '团队资产',
  members: '成员与专家',
};

export function WorkbenchPage({
  api,
  initialSection,
  appearance,
}: {
  api: WorkbenchApi;
  initialSection: Section;
  appearance: AppearanceStore;
}) {
  const [state, setState] = useState<Workbench>(emptyWorkbench);
  const [model, setModel] = useState('尚未读取');
  const [section, setSection] = useState(initialSection);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<{ content: string; id: string; revision: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [projectFilter, setProjectFilter] = useState('');
  const [search, setSearch] = useState('');
  const [assetKind, setAssetKind] = useState('all');
  async function refresh(signal?: AbortSignal) {
    setLoading(true);
    setError('');
    try {
      const result = await api.snapshot(signal);
      setState(result.state);
      setModel(result.model);
      setLoaded(true);
    } catch (e) {
      if (!signal?.aborted) setError(e instanceof Error ? e.message : '读取工作台失败。');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    const abort = new AbortController();
    void refresh(abort.signal);
    return () => abort.abort();
  }, [api]);
  async function submit(command: WorkbenchCommand): Promise<boolean> {
    setSaving(true);
    setError('');
    const content = JSON.stringify(command);
    if (pending.current?.content !== content)
      pending.current = { content, id: uid(), revision: state.revision };
    try {
      setState(await api.save(pending.current.revision, command, pending.current.id));
      pending.current = null;
      setDialog(null);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败。');
      return false;
    } finally {
      setSaving(false);
    }
  }
  function newTask(projectId = projectFilter || state.projects[0]?.id) {
    if (!projectId) {
      setDialog({ kind: 'project', value: { id: uid(), name: '', description: '' } });
      return;
    }
    setDialog({
      kind: 'task',
      value: {
        id: uid(),
        projectId,
        title: '',
        goal: '',
        status: 'draft',
        participantIds: state.participants.filter((p) => p.available).map((p) => p.id),
        ownerId: null,
        updatedAt: new Date().toISOString(),
        workflows: [{ id: uid(), name: '主工作流', parentNodeId: null, nodes: [] }],
      },
    });
  }
  const activeTask = state.tasks.find((t) => t.id === activeTaskId);
  const tasks = state.tasks
    .filter(
      (t) =>
        (!projectFilter || t.projectId === projectFilter) &&
        `${t.title} ${t.goal}`.includes(search),
    )
    .reverse();
  if (loading)
    return (
      <div className="zhuma zm-loading" role="status">
        正在连接工作台…
      </div>
    );
  if (!loaded)
    return (
      <div className="zhuma zm-loading">
        <p role="alert">{error || '尚未连接工作台。'}</p>
        <button onClick={() => void refresh()}>重新连接</button>
      </div>
    );
  if (activeTask)
    return (
      <div className="zhuma">
        <TaskEditor
          key={activeTask.id}
          original={activeTask}
          state={state}
          model={model}
          api={api}
          saved={setState}
          close={() => setActiveTaskId(null)}
          appearance={appearance}
        />
      </div>
    );
  return (
    <div className="zhuma">
      <div className="zm-page">
        <header className="zm-page-heading">
          <div className="zm-page-title">
            <h1>{labels[section]}</h1>
            {section === 'tasks' && <span>{state.tasks.length}</span>}
          </div>
          <div className="zm-actions">
            <Appearance store={appearance} />
            <Button variant="quiet" onClick={() => void refresh()}>
              刷新
            </Button>
            <button
              className="primary"
              onClick={() =>
                section === 'projects'
                  ? setDialog({ kind: 'project', value: { id: uid(), name: '', description: '' } })
                  : section === 'members'
                    ? setDialog({
                        kind: 'member',
                        value: {
                          id: uid(),
                          name: '',
                          kind: 'human',
                          role: '',
                          capabilities: [],
                          instructions: '',
                          available: true,
                        },
                      })
                    : section === 'assets'
                      ? setDialog({
                          kind: 'asset',
                          value: {
                            id: uid(),
                            name: '',
                            kind: 'skill',
                            description: '',
                            content: '',
                            available: true,
                          },
                        })
                      : newTask()
              }
            >
              ＋{' '}
              {section === 'projects'
                ? '新建项目'
                : section === 'members'
                  ? '添加成员或专家'
                  : section === 'assets'
                    ? '新建资产'
                    : '创建任务'}
            </button>
          </div>
        </header>
        <div className="zm-page-bar">
          <nav className="zm-tabs" aria-label="工作台导航">
            {(Object.keys(labels) as Section[]).map((s) => (
              <button
                key={s}
                aria-current={s === section ? 'page' : undefined}
                onClick={() => {
                  setSection(s);
                  setSearch('');
                }}
              >
                {labels[s]}
                <span>
                  {s === 'projects'
                    ? state.projects.length
                    : s === 'tasks'
                      ? state.tasks.length
                      : s === 'members'
                        ? state.participants.length
                        : state.assets.length}
                </span>
              </button>
            ))}
          </nav>
          {section === 'tasks' && (
            <div className="zm-filter">
              <input
                aria-label="搜索任务"
                placeholder="搜索任务…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <select
                aria-label="筛选项目"
                value={projectFilter}
                onChange={(e) => setProjectFilter(e.target.value)}
              >
                <option value="">所有项目</option>
                {state.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        {error && (
          <div role="alert" className="zm-error">
            {error}
          </div>
        )}
        {section === 'projects' && (
          <>
            <div className="zm-project-grid">
              {state.projects.map((p) => (
                <article className="zm-project" key={p.id}>
                  <div className="zm-project-icon">▱</div>
                  <button
                    className="zm-card-title"
                    onClick={() => {
                      setProjectFilter(p.id);
                      setSection('tasks');
                    }}
                  >
                    {p.name}
                  </button>
                  <p>{p.description || '添加项目背景，让团队和 AI 了解工作上下文。'}</p>
                  <footer>
                    <span>{state.tasks.filter((t) => t.projectId === p.id).length} 项任务</span>
                    <button onClick={() => setDialog({ kind: 'project', value: p })}>编辑</button>
                    <button onClick={() => newTask(p.id)}>创建任务 →</button>
                  </footer>
                </article>
              ))}
            </div>
            {!state.projects.length && (
              <div className="zm-welcome">
                <span className="zm-welcome-symbol">▱</span>
                <h2>先为工作建立一个项目</h2>
                <p>把相关任务、团队分工和工作流放在一起。</p>
                <button
                  className="primary"
                  onClick={() =>
                    setDialog({ kind: 'project', value: { id: uid(), name: '', description: '' } })
                  }
                >
                  新建项目
                </button>
              </div>
            )}
          </>
        )}
        {section === 'tasks' && (
          <>
            <div className="zm-task-table">
              <div className="zm-table-heading">
                <span>工作事项</span>
                <span>参与者</span>
                <span>工作流</span>
                <span>状态</span>
              </div>
              {tasks.map((t) => (
                <button className="zm-task-row" key={t.id} onClick={() => setActiveTaskId(t.id)}>
                  <span>
                    <strong>{t.title}</strong>
                    <small>
                      {state.projects.find((p) => p.id === t.projectId)?.name}
                      <span className="zm-meta-dot">·</span>
                      {state.participants.find((p) => p.id === t.ownerId)?.name ?? '负责人待定'}
                    </small>
                  </span>
                  <span className="zm-avatars">
                    {state.participants
                      .filter((p) => t.participantIds.includes(p.id))
                      .slice(0, 3)
                      .map((p) => (
                        <span title={p.name} className={`zm-avatar ${p.kind}`} key={p.id}>
                          {p.kind === 'expert' ? 'AI' : p.name[0]}
                        </span>
                      ))}
                    {t.participantIds.length > 3 && (
                      <span
                        className="zm-avatar zm-avatar-overflow"
                        title={`${t.participantIds.length} 位参与者`}
                      >
                        +{t.participantIds.length - 3}
                      </span>
                    )}
                  </span>
                  <span>
                    {t.workflows.flatMap((w) => w.nodes).length} 节点
                    {t.workflows.length > 1 && <small>{t.workflows.length} 个工作流</small>}
                  </span>
                  <span className={`zm-status ${t.status}`}>
                    {t.status === 'draft' ? '计划草稿' : '已确认'}
                  </span>
                </button>
              ))}
            </div>
            {!tasks.length && (
              <div className="zm-empty">
                <h3>{search ? '没有匹配的任务' : '开始下一项工作'}</h3>
                <p>
                  {search
                    ? '换个关键词，或清除筛选查看全部任务。'
                    : '创建任务后，选择参与者，再由 AI 或你自己编排工作流。'}
                </p>
                {search ? (
                  <button
                    onClick={() => {
                      setSearch('');
                      setProjectFilter('');
                    }}
                  >
                    清除筛选
                  </button>
                ) : (
                  <button onClick={() => newTask()} className="primary">
                    创建任务
                  </button>
                )}
              </div>
            )}
          </>
        )}
        {section === 'members' && (
          <>
            <p className="zm-section-note">维护职责与能力，供任务分配和 AI 规划使用。</p>
            <div className="zm-project-grid">
              {state.participants.map((p) => (
                <article className="zm-person-card" key={p.id}>
                  <header>
                    <span className={`zm-avatar ${p.kind}`}>
                      {p.kind === 'expert' ? 'AI' : p.name[0]}
                    </span>
                    <div>
                      <h3>{p.name}</h3>
                      <small>
                        {p.kind === 'expert' ? 'Agent 专家' : '团队成员'} ·{' '}
                        {p.available ? '可参与' : '暂不可用'}
                      </small>
                    </div>
                    <button onClick={() => setDialog({ kind: 'member', value: p })}>编辑</button>
                  </header>
                  <p>{p.role || '尚未填写职责'}</p>
                  <div className="zm-tags">
                    {p.capabilities.map((c) => (
                      <span key={c}>{c}</span>
                    ))}
                  </div>
                </article>
              ))}
            </div>
            {!state.participants.length && (
              <div className="zm-empty">
                <h3>团队里有哪些人和专家？</h3>
                <p>填写他们擅长的工作，AI 才能做出有依据的分工。</p>
              </div>
            )}
          </>
        )}
        {section === 'assets' && (
          <>
            <div className="zm-filter">
              <input
                aria-label="搜索资产"
                placeholder="搜索资产…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <select
                aria-label="资产类型"
                value={assetKind}
                onChange={(e) => setAssetKind(e.target.value)}
              >
                <option value="all">全部类型</option>
                <option value="skill">Skills</option>
                <option value="mcp">MCP</option>
                <option value="template">工作流模板</option>
              </select>
              <label className="zm-upload">
                导入定义
                <input
                  aria-label="导入资产定义"
                  type="file"
                  accept=".json,.md,.txt"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    if (f.size > 8000) {
                      setError('当前单份定义限制为 8 KB，请精简后导入。');
                      return;
                    }
                    const content = await f.text();
                    setDialog({
                      kind: 'asset',
                      value: {
                        id: uid(),
                        name: f.name.replace(/\.[^.]+$/u, ''),
                        kind: 'skill',
                        description: '',
                        content,
                        available: true,
                      },
                    });
                  }}
                />
              </label>
            </div>
            <div className="zm-project-grid">
              {state.assets
                .filter(
                  (a) =>
                    (assetKind === 'all' || a.kind === assetKind) &&
                    `${a.name} ${a.description}`.includes(search),
                )
                .map((a) => (
                  <article className="zm-asset" key={a.id}>
                    <header>
                      <span className="zm-kind">
                        {a.kind === 'template' ? '工作流模板' : a.kind.toUpperCase()}
                      </span>
                      <small>{a.available ? '可用于规划' : '已停用'}</small>
                    </header>
                    <h3>{a.name}</h3>
                    <p>{a.description || '尚未填写用途'}</p>
                    <button onClick={() => setDialog({ kind: 'asset', value: a })}>
                      查看与编辑 →
                    </button>
                  </article>
                ))}
            </div>
            {!state.assets.length && (
              <div className="zm-empty">
                <h3>把团队的方法变成可复用资产</h3>
                <p>添加 Skill、MCP 能力说明或工作流模板，用于节点配置和自动规划。</p>
              </div>
            )}
          </>
        )}
      </div>
      {dialog && (
        <Modal
          title={
            dialog.kind === 'project'
              ? '项目'
              : dialog.kind === 'member'
                ? '成员与专家'
                : dialog.kind === 'asset'
                  ? '团队资产'
                  : '创建任务'
          }
          close={() => !saving && setDialog(null)}
        >
          <form
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              const d = dialog;
              if (d.kind === 'project') void submit({ type: 'save-project', project: d.value });
              if (d.kind === 'member')
                void submit({
                  type: 'save-participant',
                  participant: {
                    ...d.value,
                    capabilities: [
                      ...new Set(d.value.capabilities.map((s) => s.trim()).filter(Boolean)),
                    ],
                  },
                });
              if (d.kind === 'asset') void submit({ type: 'save-asset', asset: d.value });
              if (d.kind === 'task')
                void submit({ type: 'save-task', task: d.value }).then((ok) => {
                  if (ok) {
                    setActiveTaskId(d.value.id);
                    setSection('tasks');
                  }
                });
            }}
          >
            <div className="zm-form-body">
              {error && (
                <div role="alert" className="zm-error">
                  {error}
                </div>
              )}
              {dialog.kind === 'project' && (
                <>
                  <Field label="项目名称">
                    <input
                      required
                      autoFocus
                      maxLength={160}
                      value={dialog.value.name}
                      onChange={(e) =>
                        setDialog({ ...dialog, value: { ...dialog.value, name: e.target.value } })
                      }
                    />
                  </Field>
                  <Field label="背景与目标">
                    <textarea
                      rows={4}
                      maxLength={8000}
                      value={dialog.value.description}
                      onChange={(e) =>
                        setDialog({
                          ...dialog,
                          value: { ...dialog.value, description: e.target.value },
                        })
                      }
                    />
                  </Field>
                </>
              )}
              {dialog.kind === 'member' && (
                <>
                  <Field label="类型">
                    <select
                      value={dialog.value.kind}
                      onChange={(e) =>
                        setDialog({
                          ...dialog,
                          value: { ...dialog.value, kind: e.target.value as Participant['kind'] },
                        })
                      }
                    >
                      <option value="human">团队成员</option>
                      <option value="expert">Agent 专家</option>
                    </select>
                  </Field>
                  <Field label="名称">
                    <input
                      required
                      maxLength={160}
                      value={dialog.value.name}
                      onChange={(e) =>
                        setDialog({ ...dialog, value: { ...dialog.value, name: e.target.value } })
                      }
                    />
                  </Field>
                  <Field label="职责">
                    <input
                      maxLength={300}
                      placeholder="例如：后端开发，负责接口和数据模型"
                      value={dialog.value.role}
                      onChange={(e) =>
                        setDialog({ ...dialog, value: { ...dialog.value, role: e.target.value } })
                      }
                    />
                  </Field>
                  <Field label="擅长的工作（逗号分隔）">
                    <input
                      value={dialog.value.capabilities.join('，')}
                      onChange={(e) =>
                        setDialog({
                          ...dialog,
                          value: { ...dialog.value, capabilities: e.target.value.split(/[,，]/u) },
                        })
                      }
                    />
                  </Field>
                  <Field
                    label={
                      dialog.value.kind === 'expert' ? '专家说明与工作方法' : '分工偏好与补充说明'
                    }
                  >
                    <textarea
                      rows={3}
                      maxLength={8000}
                      value={dialog.value.instructions}
                      onChange={(e) =>
                        setDialog({
                          ...dialog,
                          value: { ...dialog.value, instructions: e.target.value },
                        })
                      }
                    />
                  </Field>
                  <label>
                    <input
                      type="checkbox"
                      checked={dialog.value.available}
                      onChange={(e) =>
                        setDialog({
                          ...dialog,
                          value: { ...dialog.value, available: e.target.checked },
                        })
                      }
                    />
                    可以参与新任务
                  </label>
                </>
              )}
              {dialog.kind === 'asset' && (
                <>
                  <Field label="类型">
                    <select
                      value={dialog.value.kind}
                      onChange={(e) =>
                        setDialog({
                          ...dialog,
                          value: { ...dialog.value, kind: e.target.value as TeamAsset['kind'] },
                        })
                      }
                    >
                      <option value="skill">Skill</option>
                      <option value="mcp">MCP 能力定义</option>
                      <option value="template">工作流模板</option>
                    </select>
                  </Field>
                  <Field label="名称">
                    <input
                      required
                      maxLength={160}
                      value={dialog.value.name}
                      onChange={(e) =>
                        setDialog({ ...dialog, value: { ...dialog.value, name: e.target.value } })
                      }
                    />
                  </Field>
                  <Field label="用途与适用场景">
                    <textarea
                      rows={2}
                      maxLength={8000}
                      value={dialog.value.description}
                      onChange={(e) =>
                        setDialog({
                          ...dialog,
                          value: { ...dialog.value, description: e.target.value },
                        })
                      }
                    />
                  </Field>
                  <Field label="定义内容">
                    <textarea
                      rows={8}
                      maxLength={8000}
                      value={dialog.value.content}
                      onChange={(e) =>
                        setDialog({
                          ...dialog,
                          value: { ...dialog.value, content: e.target.value },
                        })
                      }
                      placeholder={
                        dialog.value.kind === 'mcp'
                          ? '描述可提供的工具与访问范围；凭据在连接设置中配置'
                          : '填写执行方法、工作步骤或模板内容'
                      }
                    />
                  </Field>
                  <label>
                    <input
                      type="checkbox"
                      checked={dialog.value.available}
                      onChange={(e) =>
                        setDialog({
                          ...dialog,
                          value: { ...dialog.value, available: e.target.checked },
                        })
                      }
                    />
                    可用于规划
                  </label>
                </>
              )}
              {dialog.kind === 'task' && (
                <>
                  <Field label="所属项目">
                    <select
                      value={dialog.value.projectId}
                      onChange={(e) =>
                        setDialog({
                          ...dialog,
                          value: { ...dialog.value, projectId: e.target.value },
                        })
                      }
                    >
                      {state.projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="任务名称">
                    <input
                      required
                      maxLength={160}
                      autoFocus
                      value={dialog.value.title}
                      onChange={(e) =>
                        setDialog({ ...dialog, value: { ...dialog.value, title: e.target.value } })
                      }
                      placeholder="这次想完成什么？"
                    />
                  </Field>
                  <Field label="任务目标">
                    <textarea
                      rows={3}
                      maxLength={8000}
                      value={dialog.value.goal}
                      onChange={(e) =>
                        setDialog({ ...dialog, value: { ...dialog.value, goal: e.target.value } })
                      }
                      placeholder="描述背景和预期结果"
                    />
                  </Field>
                  <h3>
                    参与者 <small>{dialog.value.participantIds.length} 位</small>
                  </h3>
                  <MemberPicker
                    members={state.participants}
                    selected={dialog.value.participantIds}
                    change={(participantIds) =>
                      setDialog({ ...dialog, value: { ...dialog.value, participantIds } })
                    }
                  />
                  <ParticipantSelect
                    label="任务负责人"
                    members={state.participants.filter(
                      (p) => p.kind === 'human' && dialog.value.participantIds.includes(p.id),
                    )}
                    selected={dialog.value.ownerId ? [dialog.value.ownerId] : []}
                    change={(ids) =>
                      setDialog({ ...dialog, value: { ...dialog.value, ownerId: ids[0] ?? null } })
                    }
                  />
                  {!dialog.value.ownerId && <small>可先保存草稿，确认工作流前需选择负责人。</small>}
                </>
              )}
            </div>
            <footer>
              <button type="button" disabled={saving} onClick={() => setDialog(null)}>
                取消
              </button>
              <button type="submit" disabled={saving} className="primary">
                {saving ? '正在保存…' : dialog.kind === 'task' ? '创建并编排' : '保存'}
              </button>
            </footer>
          </form>
        </Modal>
      )}
    </div>
  );
}
