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
  const [dialogError, setDialogError] = useState('');
  const pending = useRef<{ content: string; id: string; revision: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [projectFilter, setProjectFilter] = useState('');
  const [search, setSearch] = useState('');
  const [assetKind, setAssetKind] = useState('all');
  const [memberKind, setMemberKind] = useState('all');
  const [importing, setImporting] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  function openDialog(next: Dialog) {
    setDialog(structuredClone(next));
    setError('');
    setDialogError('');
    pending.current = null;
  }
  function createCatalogItem() {
    if (section === 'projects')
      openDialog({ kind: 'project', value: { id: uid(), name: '', description: '' } });
    else if (section === 'members')
      openDialog({
        kind: 'member',
        value: {
          id: uid(),
          name: '',
          kind: memberKind === 'expert' ? 'expert' : 'human',
          role: '',
          capabilities: [],
          instructions: '',
          available: true,
        },
      });
    else if (section === 'assets')
      openDialog({
        kind: 'asset',
        value: {
          id: uid(),
          name: '',
          kind: assetKind === 'all' ? 'skill' : (assetKind as TeamAsset['kind']),
          description: '',
          content: '',
          available: true,
        },
      });
    else newTask();
  }
  const createLabel =
    section === 'projects'
      ? '新建项目'
      : section === 'members'
        ? '添加成员或专家'
        : section === 'assets'
          ? '新建资产'
          : '创建任务';
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
    setDialogError('');
    const content = JSON.stringify(command);
    if (pending.current?.content !== content)
      pending.current = { content, id: uid(), revision: state.revision };
    try {
      setState(await api.save(pending.current.revision, command, pending.current.id));
      pending.current = null;
      setDialog(null);
      return true;
    } catch (e) {
      setDialogError(e instanceof Error ? e.message : '保存失败，请重试。');
      return false;
    } finally {
      setSaving(false);
    }
  }
  function newTask(projectId = projectFilter || state.projects[0]?.id) {
    if (!projectId) {
      openDialog({ kind: 'project', value: { id: uid(), name: '', description: '' } });
      return;
    }
    openDialog({
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
  const matches = (value: string) => value.toLowerCase().includes(search.trim().toLowerCase());
  const projects = state.projects.filter((p) => matches(`${p.name} ${p.description}`));
  const members = state.participants.filter(
    (p) =>
      (memberKind === 'all' || p.kind === memberKind) &&
      matches(`${p.name} ${p.role} ${p.capabilities.join(' ')}`),
  );
  const assets = state.assets.filter(
    (a) => (assetKind === 'all' || a.kind === assetKind) && matches(`${a.name} ${a.description}`),
  );
  const total =
    section === 'projects'
      ? state.projects.length
      : section === 'members'
        ? state.participants.length
        : section === 'assets'
          ? state.assets.length
          : state.tasks.length;
  const visibleCount =
    section === 'projects'
      ? projects.length
      : section === 'members'
        ? members.length
        : assets.length;
  const dialogExists =
    dialog &&
    (dialog.kind === 'project'
      ? state.projects
      : dialog.kind === 'member'
        ? state.participants
        : dialog.kind === 'asset'
          ? state.assets
          : state.tasks
    ).some((item) => item.id === dialog.value.id);
  const tasks = state.tasks
    .filter(
      (t) => (!projectFilter || t.projectId === projectFilter) && matches(`${t.title} ${t.goal}`),
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
            <span>{total}</span>
          </div>
          <div className="zm-actions">
            <Appearance store={appearance} />
            <Button variant="quiet" onClick={() => void refresh()}>
              刷新
            </Button>
            {section === 'assets' && (
              <>
                <Button
                  busy={importing}
                  busyLabel="正在读取…"
                  onClick={() => importRef.current?.click()}
                >
                  导入定义
                </Button>
                <input
                  hidden
                  ref={importRef}
                  aria-label="导入资产定义"
                  type="file"
                  accept=".json,.md,.txt"
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (!file) return;
                    setError('');
                    if (file.size > 8000) {
                      setError('文件超过 8 KB，请精简后重新导入。');
                      return;
                    }
                    setImporting(true);
                    try {
                      const content = await file.text();
                      openDialog({
                        kind: 'asset',
                        value: {
                          id: uid(),
                          name: file.name.replace(/\.[^.]+$/u, '').slice(0, 160),
                          kind: assetKind === 'all' ? 'skill' : (assetKind as TeamAsset['kind']),
                          description: '',
                          content,
                          available: true,
                        },
                      });
                    } catch {
                      setError('读取文件失败，请重新选择文件。');
                    } finally {
                      setImporting(false);
                    }
                  }}
                />
              </>
            )}
            <Button variant="primary" onClick={createCatalogItem}>
              ＋ {createLabel}
            </Button>
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
          {section !== 'tasks' && (
            <div className="zm-filter">
              <input
                type="search"
                aria-label={
                  section === 'projects'
                    ? '搜索项目'
                    : section === 'members'
                      ? '搜索成员与专家'
                      : '搜索资产'
                }
                placeholder={
                  section === 'projects'
                    ? '搜索项目…'
                    : section === 'members'
                      ? '搜索姓名、职责或能力…'
                      : '搜索资产…'
                }
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              {section === 'members' && (
                <select
                  aria-label="成员类型"
                  value={memberKind}
                  onChange={(event) => setMemberKind(event.target.value)}
                >
                  <option value="all">所有成员与专家</option>
                  <option value="human">团队成员</option>
                  <option value="expert">Agent 专家</option>
                </select>
              )}
              {section === 'assets' && (
                <select
                  aria-label="资产类型"
                  value={assetKind}
                  onChange={(event) => setAssetKind(event.target.value)}
                >
                  <option value="all">全部类型</option>
                  <option value="skill">Skills</option>
                  <option value="mcp">MCP</option>
                  <option value="template">工作流模板</option>
                </select>
              )}
            </div>
          )}
        </div>
        {error && (
          <div role="alert" className="zm-error">
            {error}
          </div>
        )}
        {section === 'projects' && !!projects.length && (
          <div className="zm-directory zm-project-directory">
            {projects.map((p) => (
              <article className="zm-directory-row" key={p.id} aria-label={p.name}>
                <span className="zm-directory-symbol" aria-hidden>
                  ▱
                </span>
                <div className="zm-directory-content">
                  <Button
                    variant="quiet"
                    className="zm-directory-title"
                    onClick={() => {
                      setProjectFilter(p.id);
                      setSearch('');
                      setSection('tasks');
                    }}
                  >
                    {p.name}
                  </Button>
                  <p title={p.description}>{p.description || '暂无项目背景'}</p>
                </div>
                <span className="zm-directory-meta">
                  {state.tasks.filter((t) => t.projectId === p.id).length} 项任务
                </span>
                <div className="zm-directory-actions">
                  <Button variant="quiet" onClick={() => openDialog({ kind: 'project', value: p })}>
                    编辑
                  </Button>
                  <Button onClick={() => newTask(p.id)}>创建任务</Button>
                </div>
              </article>
            ))}
          </div>
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
        {section === 'members' && !!members.length && (
          <div className="zm-directory zm-member-directory">
            <div className="zm-directory-heading">
              <span>成员 / 专家</span>
              <span>职责与能力</span>
              <span>状态</span>
              <span />
            </div>
            {members.map((p) => (
              <article className="zm-directory-row" key={p.id} aria-label={p.name}>
                <div className="zm-directory-identity">
                  <span className={`zm-avatar ${p.kind}`}>
                    {p.kind === 'expert' ? 'AI' : p.name[0]}
                  </span>
                  <div>
                    <h3>{p.name}</h3>
                    <small>{p.kind === 'expert' ? 'Agent 专家' : '团队成员'}</small>
                  </div>
                </div>
                <div className="zm-directory-content">
                  <p title={p.role}>{p.role || '暂无职责说明'}</p>
                  <div className="zm-tags">
                    {p.capabilities.slice(0, 3).map((c) => (
                      <span key={c}>{c}</span>
                    ))}
                    {p.capabilities.length > 3 && (
                      <span title={p.capabilities.join('、')}>+{p.capabilities.length - 3}</span>
                    )}
                  </div>
                </div>
                <span className={`zm-availability ${p.available ? '' : 'unavailable'}`}>
                  {p.available ? '可参与' : '暂不可用'}
                </span>
                <Button variant="quiet" onClick={() => openDialog({ kind: 'member', value: p })}>
                  编辑
                </Button>
              </article>
            ))}
          </div>
        )}
        {section === 'assets' && !!assets.length && (
          <div className="zm-directory zm-asset-directory">
            <div className="zm-directory-heading">
              <span>类型</span>
              <span>名称与用途</span>
              <span>状态</span>
              <span />
            </div>
            {assets.map((a) => (
              <article className="zm-directory-row" key={a.id} aria-label={a.name}>
                <span className="zm-kind">
                  {a.kind === 'template' ? '工作流模板' : a.kind === 'skill' ? 'Skill' : 'MCP'}
                </span>
                <div className="zm-directory-content">
                  <h3>{a.name}</h3>
                  <p title={a.description}>{a.description || '暂无用途说明'}</p>
                </div>
                <span className={`zm-availability ${a.available ? '' : 'unavailable'}`}>
                  {a.available ? '已启用' : '已停用'}
                </span>
                <Button variant="quiet" onClick={() => openDialog({ kind: 'asset', value: a })}>
                  编辑
                </Button>
              </article>
            ))}
          </div>
        )}
        {section !== 'tasks' && !visibleCount && (
          <div className="zm-empty zm-directory-empty">
            <h3>{total ? `没有匹配的${labels[section]}` : `暂无${labels[section]}`}</h3>
            <p>
              {total
                ? '换个关键词，或清除筛选。'
                : section === 'projects'
                  ? '创建项目，集中管理相关工作。'
                  : section === 'members'
                    ? '添加团队成员或 Agent 专家，填写职责后参与分工。'
                    : '新建或导入 Skill、MCP 能力定义和工作流模板。'}
            </p>
            {total ? (
              <Button
                onClick={() => {
                  setSearch('');
                  setMemberKind('all');
                  setAssetKind('all');
                }}
              >
                清除筛选
              </Button>
            ) : (
              <Button variant="primary" onClick={createCatalogItem}>
                {createLabel}
              </Button>
            )}
          </div>
        )}
      </div>
      {dialog && (
        <Modal
          title={
            dialog.kind === 'task'
              ? '创建任务'
              : `${dialogExists ? '编辑' : '新建'}${dialog.kind === 'project' ? '项目' : dialog.kind === 'member' ? (dialog.value.kind === 'expert' ? '专家' : '成员') : '资产'}`
          }
          close={() => !saving && setDialog(null)}
        >
          <form
            className={dialog.kind === 'task' ? 'zm-task-form' : 'zm-catalog-form'}
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
              <fieldset className="zm-form-fields" disabled={saving}>
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
                    <div className="zm-form-row">
                      <Field label="名称">
                        <input
                          autoFocus
                          required
                          maxLength={160}
                          value={dialog.value.name}
                          onChange={(e) =>
                            setDialog({
                              ...dialog,
                              value: { ...dialog.value, name: e.target.value },
                            })
                          }
                        />
                      </Field>
                      <Field label="类型">
                        <select
                          value={dialog.value.kind}
                          onChange={(e) =>
                            setDialog({
                              ...dialog,
                              value: {
                                ...dialog.value,
                                kind: e.target.value as Participant['kind'],
                              },
                            })
                          }
                        >
                          <option value="human">团队成员</option>
                          <option value="expert">Agent 专家</option>
                        </select>
                      </Field>
                    </div>
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
                            value: {
                              ...dialog.value,
                              capabilities: e.target.value.split(/[,，]/u),
                            },
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
                    <label className="zm-check-row">
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
                    <div className="zm-form-row">
                      <Field label="名称">
                        <input
                          autoFocus
                          required
                          maxLength={160}
                          value={dialog.value.name}
                          onChange={(e) =>
                            setDialog({
                              ...dialog,
                              value: { ...dialog.value, name: e.target.value },
                            })
                          }
                        />
                      </Field>
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
                    </div>
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
                    <label className="zm-check-row">
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
                          setDialog({
                            ...dialog,
                            value: { ...dialog.value, title: e.target.value },
                          })
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
                        setDialog({
                          ...dialog,
                          value: { ...dialog.value, ownerId: ids[0] ?? null },
                        })
                      }
                    />
                    {!dialog.value.ownerId && (
                      <small>可先保存草稿，确认工作流前需选择负责人。</small>
                    )}
                  </>
                )}
              </fieldset>
            </div>
            {dialogError && (
              <div role="alert" className="zm-error zm-dialog-error">
                {dialogError}
              </div>
            )}
            <footer>
              <Button disabled={saving} onClick={() => setDialog(null)}>
                取消
              </Button>
              <Button type="submit" variant="primary" busy={saving} busyLabel="正在保存…">
                {dialog.kind === 'task' ? '创建并编排' : '保存'}
              </Button>
            </footer>
          </form>
        </Modal>
      )}
    </div>
  );
}
