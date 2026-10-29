import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  emptyWorkbench,
  parseWorkflowTemplate,
  type Workbench,
  type WorkTask,
  type Project,
  type Participant,
  type TeamAsset,
  type WorkbenchCommand,
} from '@zhuma/agent-core';
import type { WorkbenchApi, WorkbenchWriteIntent } from './api.js';
import { useUnsavedChanges } from './UnsavedChanges.js';
import { Field, Modal, ParticipantSelect, MultiSelect } from './controls.js';
import { TaskEditor, type InitialPlanning } from './TaskEditor.js';
import { Appearance, type AppearanceStore } from './Appearance.js';
import { Button } from './Button.js';
import { SingleSelect } from './SingleSelect.js';
import { TemplateBrowser } from './TemplateBrowser.js';
import { TemplateBindings, type TemplateBindingValues } from './TemplateBindings.js';
import { TemplateDefinitionEditor } from './TemplateDefinitionEditor.js';
import { AssetImportDialog } from './AssetImportDialog.js';
import { ResourceSourceDialog } from './SourceFiles.js';
import { ExpertBrowser, type ExpertBrowserView } from './ExpertBrowser.js';
import type { NativeRunApi } from '../run/api.js';
import { ControlIcon } from './ControlIcon.js';
import { TaskBoard } from './TaskBoard.js';
import { taskBoardColumn, taskBoardColumns } from './task-board.js';
import { emptyTaskFilters, taskFilterCandidates } from './task-filters.js';
import { useTaskFilters } from './useTaskFilters.js';
import { PlanningReadiness, usePlanningReadiness } from './PlanningReadiness.js';
import {
  latestTaskPlan,
  useTaskProgress,
  type TaskProgressState,
} from '../execution/useTaskProgress.js';
import { TaskProgressSummary } from '../execution/TaskProgressSummary.js';
import { KnowledgePanel, type KnowledgePanelProps } from '../knowledge/KnowledgePanel.js';
import type { ProjectKnowledgeApi } from '../knowledge/project-knowledge-api.js';
import { useLeaveConfirmation } from './useLeaveConfirmation.js';
import {
  ProjectHub,
  ProjectFields,
  defaultProjectParticipants,
  type ProjectTab,
} from './ProjectHub.js';

type Section = 'projects' | 'tasks' | 'assets' | 'members' | 'knowledge';
type Dialog =
  | { kind: 'project'; value: Project }
  | { kind: 'member'; value: Participant }
  | { kind: 'asset'; value: TeamAsset }
  | {
      kind: 'task';
      value: WorkTask;
      participantIdsEdited: boolean;
      planning: 'ai' | 'manual' | 'template';
      template: {
        assetId: string;
        roles: TemplateBindingValues;
        resources: TemplateBindingValues;
      } | null;
    };
const uid = () => crypto.randomUUID();
const labels: Record<Section, string> = {
  projects: '项目',
  tasks: '任务清单',
  assets: '团队资产',
  members: '成员与专家',
  knowledge: '知识',
};

export function WorkbenchPage({
  api,
  initialSection,
  appearance,
  expertLibrary = false,
  openWork,
  nativeRun,
  projectExecution,
  legacyMode = false,
  knowledge,
}: {
  api: WorkbenchApi;
  initialSection: Section;
  appearance: AppearanceStore;
  expertLibrary?: boolean;
  openWork?: () => void;
  nativeRun?: { api: NativeRunApi; spaceId: string };
  projectExecution?:
    | {
        readonly spaceId: string;
        readonly api: Pick<
          import('../execution/ExecutionApi.js').ExecutionApi,
          'files' | 'projectArtifacts' | 'taskProgress'
        >;
      }
    | undefined;
  legacyMode?: boolean;
  knowledge?:
    (Omit<KnowledgePanelProps, 'onDirtyChange'> & { projectApi?: ProjectKnowledgeApi }) | undefined;
}) {
  const [state, setState] = useState<Workbench>(emptyWorkbench);
  const [model, setModel] = useState('尚未读取');
  const [section, setSection] = useState(initialSection);
  const [knowledgeDirty, setKnowledgeDirty] = useState(false);
  const [projectKnowledgeDirty, setProjectKnowledgeDirty] = useState(false);
  const knowledgeLeave = useLeaveConfirmation(() => knowledge?.lifetime.isCurrent() ?? true);
  function leaveKnowledge(action: () => void) {
    knowledgeLeave.request(action, knowledgeDirty || projectKnowledgeDirty);
  }
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [dialogError, setDialogError] = useState('');
  const pending = useRef<{
    content: string;
    id: string;
    revision: number;
    intent: WorkbenchWriteIntent | undefined;
  } | null>(null);
  const member = api.member;
  const capabilities = member?.capabilities();
  const planningReadiness = usePlanningReadiness(api, model);
  const dialogBaseline = useRef('');
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  useUnsavedChanges(saving || (!!dialog && JSON.stringify(dialog) !== dialogBaseline.current));
  const [taskAfterProject, setTaskAfterProject] = useState<Extract<
    Dialog,
    { kind: 'task' }
  > | null>(null);
  const [templateBrowserOpen, setTemplateBrowserOpen] = useState(false);
  const [definitionEditorOpen, setDefinitionEditorOpen] = useState(false);
  const templateId = dialog?.kind === 'task' ? dialog.template?.assetId : null;
  const selectedTemplate = state.assets.find((a) => a.id === templateId && a.kind === 'template');
  const selectedDefinition = useMemo(() => {
    if (!selectedTemplate) return null;
    try {
      return parseWorkflowTemplate(selectedTemplate.content);
    } catch {
      return null;
    }
  }, [selectedTemplate]);
  const assetContent =
    dialog?.kind === 'asset' && dialog.value.kind === 'template' ? dialog.value.content : null;
  const assetDefinition = useMemo(() => {
    if (assetContent === null) return null;
    try {
      return parseWorkflowTemplate(assetContent);
    } catch {
      return null;
    }
  }, [assetContent]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [taskFilters, setTaskFilters] = useTaskFilters(
    member && projectExecution
      ? {
          accountId: member.actorId,
          spaceId: projectExecution.spaceId,
        }
      : undefined,
  );
  const taskView = taskFilters.view;
  const setTaskView = (view: 'list' | 'board') => setTaskFilters({ ...taskFilters, view });
  const [initialPlanning, setInitialPlanning] = useState<InitialPlanning | null>(null);
  const submitting = useRef(false);
  const pageGeneration = useRef(0);
  useEffect(
    () => () => {
      pageGeneration.current += 1;
    },
    [],
  );
  useEffect(() => () => initialPlanning?.controller.abort(), [initialPlanning]);
  const projectFilter = state.projects.some((project) => project.id === taskFilters.projectId)
    ? taskFilters.projectId
    : '';
  const participantFilter = state.participants.some(
    (person) => person.id === taskFilters.participantId,
  )
    ? taskFilters.participantId
    : '';
  const setProjectFilter = (projectId: string) => setTaskFilters({ ...taskFilters, projectId });
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [projectTab, setProjectTab] = useState<ProjectTab>('overview');
  const activeProject =
    section === 'projects' ? state.projects.find((p) => p.id === activeProjectId) : undefined;
  const [search, setSearch] = useState('');
  const [assetKind, setAssetKind] = useState(expertLibrary ? 'expert' : 'all');
  const [memberKind, setMemberKind] = useState('all');
  const [expertView, setExpertView] = useState<ExpertBrowserView>({
    search: '',
    role: '',
    selectedId: null,
  });
  const [importOpen, setImportOpen] = useState(false);
  const [sourceDialog, setSourceDialog] = useState<{
    kind: 'asset' | 'expert';
    id: string;
    name: string;
    versionId: string;
  } | null>(null);
  function openDialog(next: Dialog) {
    dialogBaseline.current = JSON.stringify(next);
    setDialog(structuredClone(next));
    setTaskAfterProject(null);
    setError('');
    setDialogError('');
    pending.current = null;
  }
  function createProjectForTask(draft: Extract<Dialog, { kind: 'task' }>) {
    openDialog({
      kind: 'project',
      value: { id: uid(), name: '', description: '', defaultParticipantIds: [] },
    });
    setTaskAfterProject(structuredClone(draft));
  }
  function closeDialog() {
    if (dialog?.kind === 'project' && taskAfterProject) {
      setDialog(taskAfterProject);
      setTaskAfterProject(null);
      setDialogError('');
      pending.current = null;
    } else setDialog(null);
  }
  function createCatalogItem() {
    if (activeProject) newTask(activeProject.id);
    else if (section === 'projects')
      openDialog({
        kind: 'project',
        value: { id: uid(), name: '', description: '', defaultParticipantIds: [] },
      });
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
    else if (section === 'assets' && assetKind === 'expert')
      openDialog({
        kind: 'member',
        value: {
          id: uid(),
          name: '',
          kind: 'expert',
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
  const createLabel = activeProject
    ? '创建任务'
    : section === 'projects'
      ? '新建项目'
      : section === 'members'
        ? '添加成员或专家'
        : section === 'assets'
          ? assetKind === 'expert'
            ? '新建专家'
            : '新建资产'
          : '创建任务';
  const canCreate =
    !member ||
    (activeProject || section === 'tasks'
      ? capabilities?.createTask || (!state.projects.length && capabilities?.createProject)
      : section === 'projects' && capabilities?.createProject);
  function initialParticipants(project: Project | undefined, current = state) {
    if (!member && !project) return [];
    const ids = defaultProjectParticipants(project, current);
    const self =
      member &&
      current.participants.find(
        (p) => p.id === member.actorId && p.kind === 'human' && p.available,
      );
    return self ? [...new Set([self.id, ...ids])] : ids;
  }
  function originInfo(value: Participant | TeamAsset, kind: 'asset' | 'expert') {
    if (!value.origin) return null;
    return (
      <section className="zm-origin-info">
        <div>
          <span>
            {value.origin.filePaths.length} 个来源文件 · 包版本 {value.origin.versionId.slice(0, 8)}
          </span>
          <Button
            onClick={() =>
              setSourceDialog({
                kind,
                id: value.id,
                name: value.name,
                versionId: value.origin!.versionId,
              })
            }
          >
            查看来源
          </Button>
        </div>
        {!!value.origin.missing.length && (
          <p className="zm-warning">仍需补齐 {value.origin.missing.length} 项，当前不能启用。</p>
        )}
        <small>更新正文或文件时，请重新导入并选择更新已有定义。</small>
      </section>
    );
  }
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
  async function submit(command: WorkbenchCommand): Promise<Workbench | null> {
    if (submitting.current) return null;
    submitting.current = true;
    setSaving(true);
    setDialogError('');
    const content = JSON.stringify(command);
    if (pending.current?.content !== content) {
      const intent: WorkbenchWriteIntent | undefined =
        command.type === 'save-project'
          ? state.projects.some((p) => p.id === command.project.id)
            ? 'update-project'
            : 'create-project'
          : command.type === 'save-task'
            ? command.task.status === 'ready'
              ? 'confirm-task'
              : state.tasks.some((t) => t.id === command.task.id)
                ? 'update-task'
                : 'create-task'
            : command.type === 'instantiate-template'
              ? 'create-task'
              : undefined;
      pending.current = { content, id: uid(), revision: state.revision, intent };
    }
    try {
      const committed = await api.save(
        pending.current.revision,
        command,
        pending.current.id,
        pending.current.intent,
      );
      setState(committed);
      if (command.type === 'save-project') {
        if (taskAfterProject) {
          setDialog({
            ...taskAfterProject,
            value: {
              ...taskAfterProject.value,
              projectId: command.project.id,
              participantIds: taskAfterProject.participantIdsEdited
                ? taskAfterProject.value.participantIds
                : initialParticipants(command.project, committed),
            },
          });
          setTaskAfterProject(null);
          setProjectFilter(command.project.id);
        } else {
          setActiveProjectId(command.project.id);
          setSection('projects');
          setSearch('');
          setDialog(null);
        }
      } else {
        setDialog(null);
      }
      if (
        expertLibrary &&
        command.type === 'save-participant' &&
        command.participant.kind === 'expert'
      )
        setExpertView({ search: '', role: '', selectedId: command.participant.id });
      pending.current = null;
      return committed;
    } catch (e) {
      setDialogError(e instanceof Error ? e.message : '保存失败，请重试。');
      return null;
    } finally {
      setSaving(false);
      submitting.current = false;
    }
  }
  async function createTask(draft: Extract<Dialog, { kind: 'task' }>) {
    if (!state.projects.some((project) => project.id === draft.value.projectId)) {
      if (!state.projects.length) createProjectForTask(draft);
      else setDialogError('所属项目已不可用，请重新选择或新建项目。');
      return;
    }
    const generation = pageGeneration.current;
    const goal = draft.value.goal.trim();
    if (!goal) {
      setDialogError('请描述这次要完成的目标。');
      return;
    }
    if (
      draft.planning === 'ai' &&
      !state.participants.some((p) => p.available && draft.value.participantIds.includes(p.id))
    ) {
      setDialogError('请至少选择一位可参与的人或专家，再生成计划。');
      return;
    }
    const task = {
      ...draft.value,
      goal,
      title: draft.value.title.trim() || goal.split('\n')[0]!.slice(0, 60),
    };
    if (draft.planning === 'template' && !draft.template) {
      setDialogError('请选择要使用的工作流。');
      return;
    }
    const { workflows: _workflows, status: _status, templateSource: _source, ...seed } = task;
    const committed = await submit(
      draft.planning === 'template' && draft.template
        ? {
            type: 'instantiate-template',
            input: {
              task: seed,
              templateId: draft.template.assetId,
              roleBindings: draft.template.roles,
              resourceBindings: draft.template.resources,
            },
          }
        : { type: 'save-task', task },
    );
    // The Host may have saved after this panel was removed. Keep that draft, but do not
    // start a paid planning request or navigate from a stale create-form submission.
    if (!committed || generation !== pageGeneration.current) return;
    if (draft.planning === 'ai') {
      const controller = new AbortController();
      const result: InitialPlanning['result'] = Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted();
          return api.plan(task.id, committed.revision, '', controller.signal);
        })
        .then(
          (proposal) => ({ ok: true, proposal }),
          (error: unknown) => ({ ok: false, error }),
        );
      setInitialPlanning({ controller, result });
    } else setInitialPlanning(null);
    setActiveTaskId(task.id);
    if (activeProjectId) {
      setActiveProjectId(task.projectId);
      setSection('projects');
    } else setSection('tasks');
  }
  function newTask(projectId = projectFilter || state.projects[0]?.id) {
    if (
      member &&
      !capabilities?.createTask &&
      !(!state.projects.length && capabilities?.createProject)
    )
      return;
    const availableProjectId = state.projects.some((project) => project.id === projectId)
      ? projectId
      : undefined;
    openDialog({
      kind: 'task',
      participantIdsEdited: false,
      planning: member && !capabilities?.planning ? 'manual' : 'ai',
      template: null,
      value: {
        id: uid(),
        projectId: availableProjectId ?? '',
        title: '',
        goal: '',
        status: 'draft',
        participantIds: initialParticipants(
          state.projects.find((p) => p.id === availableProjectId),
        ),
        ownerId: member?.actorId ?? null,
        updatedAt: new Date().toISOString(),
        workflows: [{ id: uid(), name: '主工作流', parentNodeId: null, nodes: [] }],
      },
    });
  }
  function changeTaskParticipants(participantIds: string[]) {
    if (dialog?.kind !== 'task') return;
    setDialog({
      ...dialog,
      participantIdsEdited: true,
      value: {
        ...dialog.value,
        participantIds,
        ownerId: participantIds.includes(dialog.value.ownerId ?? '') ? dialog.value.ownerId : null,
      },
      template: dialog.template
        ? {
            ...dialog.template,
            roles: Object.fromEntries(
              Object.entries(dialog.template.roles).map(([key, value]) => [
                key,
                value && participantIds.includes(value) ? value : null,
              ]),
            ),
          }
        : null,
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
  const catalog = [
    ...state.assets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      kind: asset.kind,
      description: asset.description,
      available: asset.available,
      origin: asset.origin,
      asset,
      expert: null,
    })),
    ...state.participants
      .filter((p) => p.kind === 'expert')
      .map((expert) => ({
        id: expert.id,
        name: expert.name,
        kind: 'expert' as const,
        description: `${expert.role} ${expert.capabilities.join(' · ')}`.trim(),
        available: expert.available,
        origin: expert.origin,
        asset: null,
        expert,
      })),
  ].sort(
    (a, b) =>
      ['template', 'expert', 'skill', 'mcp'].indexOf(a.kind) -
      ['template', 'expert', 'skill', 'mcp'].indexOf(b.kind),
  );
  const catalogMatches = catalog.filter((a) => matches(`${a.name} ${a.description}`));
  const assets = catalogMatches.filter((a) => assetKind === 'all' || a.kind === assetKind);
  const catalogTotal =
    assetKind === 'all' ? catalog.length : catalog.filter((a) => a.kind === assetKind).length;
  const directoryTotal =
    section === 'assets'
      ? catalogTotal
      : section === 'projects'
        ? state.projects.length
        : state.participants.length;
  const total =
    section === 'projects'
      ? state.projects.length
      : section === 'members'
        ? state.participants.length
        : section === 'assets'
          ? catalog.length
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
  const taskCandidates = taskFilterCandidates(state.tasks, {
    ...taskFilters,
    projectId: projectFilter,
    participantId: participantFilter,
  });
  const progressTasks = activeTask
    ? [activeTask]
    : activeProject && ['overview', 'work'].includes(projectTab)
      ? state.tasks
          .filter((task) => task.projectId === activeProject.id)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, projectTab === 'overview' ? 5 : undefined)
      : section === 'tasks'
        ? taskCandidates
        : [];
  const progressPlans = progressTasks.flatMap((task) => {
    const plan = latestTaskPlan(state.appliedPlans, task.id);
    return plan ? [{ taskId: task.id, planId: plan.id, revision: plan.revision }] : [];
  });
  const progress = useTaskProgress(
    projectExecution?.api.taskProgress,
    projectExecution?.spaceId,
    progressPlans,
    state,
  );
  function progressFor(taskId: string): TaskProgressState | undefined {
    if (!state.appliedPlans.some((plan) => plan.taskId === taskId)) return undefined;
    if (!latestTaskPlan(state.appliedPlans, taskId))
      return { state: 'error', message: '当前确认计划不唯一，请刷新。' };
    return progress.get(taskId);
  }
  const stageFor = (task: WorkTask) =>
    taskBoardColumn(
      task,
      state.appliedPlans.some((plan) => plan.taskId === task.id),
      progressFor(task.id),
    );
  const tasks = taskCandidates.filter(
    (task) => !taskFilters.stage || stageFor(task) === taskFilters.stage,
  );
  const stageLoading = taskCandidates.some((task) => progressFor(task.id)?.state === 'loading');
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
          close={() => {
            setInitialPlanning(null);
            setActiveTaskId(null);
          }}
          appearance={appearance}
          progress={progressFor(activeTask.id)}
          refreshProgress={progress.refresh}
          backLabel={activeProject ? '项目' : '任务清单'}
          {...(initialPlanning ? { initialPlanning } : {})}
          {...(openWork ? { openWork } : {})}
          {...(nativeRun ? { nativeRun } : {})}
        />
      </div>
    );
  return (
    <div className="zhuma">
      {knowledgeLeave.dialog}
      <div className={`zm-page${activeProject ? ' zm-project-page' : ''}`}>
        {section !== 'knowledge' && (
          <header className="zm-page-heading">
            <div className="zm-page-title">
              {activeProject && (
                <Button
                  variant="quiet"
                  onClick={() => leaveKnowledge(() => setActiveProjectId(null))}
                >
                  <ControlIcon direction="left" /> 全部项目
                </Button>
              )}
              <h1>{expertLibrary ? '专家' : (activeProject?.name ?? labels[section])}</h1>
              <span>
                {expertLibrary
                  ? state.participants.filter((p) => p.kind === 'expert').length
                  : activeProject
                    ? undefined
                    : total}
              </span>
            </div>
            <div className="zm-actions">
              <Appearance store={appearance} />
              <Button variant="quiet" onClick={() => void refresh()}>
                刷新
              </Button>
              {activeProject && (!member || capabilities?.createProject) && (
                <Button onClick={() => openDialog({ kind: 'project', value: activeProject })}>
                  编辑项目
                </Button>
              )}
              {!member && section === 'assets' && (
                <Button onClick={() => setImportOpen(true)}>
                  {expertLibrary ? '导入专家' : '导入定义'}
                </Button>
              )}
              <Button
                variant="primary"
                disabled={!!member && (loading || saving || !canCreate)}
                onClick={() => leaveKnowledge(createCatalogItem)}
              >
                ＋ {createLabel}
              </Button>
            </div>
          </header>
        )}
        {legacyMode && (
          <p className="zm-mode-notice">当前保留单人模式；已有资料不会自动迁入团队。</p>
        )}
        {!expertLibrary && (
          <div className={`zm-page-bar${section === 'tasks' ? ' zm-task-page-bar' : ''}`}>
            <nav className="zm-tabs" aria-label="工作台导航">
              {(Object.keys(labels) as Section[])
                .filter((s) =>
                  s === 'knowledge' ? !!knowledge : !member || s === 'projects' || s === 'tasks',
                )
                .map((s) => (
                  <button
                    key={s}
                    aria-current={s === section ? 'page' : undefined}
                    onClick={() => {
                      if (s === section && !activeProject) return;
                      leaveKnowledge(() => {
                        setSection(s);
                        setSearch('');
                        setActiveProjectId(null);
                      });
                    }}
                  >
                    {labels[s]}
                    {s !== 'knowledge' && (
                      <span>
                        {s === 'projects'
                          ? state.projects.length
                          : s === 'tasks'
                            ? state.tasks.length
                            : s === 'members'
                              ? state.participants.length
                              : catalog.length}
                      </span>
                    )}
                  </button>
                ))}
            </nav>
            {section === 'tasks' && (
              <div className="zm-task-view" role="group" aria-label="任务显示方式">
                <Button
                  variant="quiet"
                  aria-pressed={taskView === 'list'}
                  onClick={() => setTaskView('list')}
                >
                  列表
                </Button>
                <Button
                  variant="quiet"
                  aria-pressed={taskView === 'board'}
                  onClick={() => setTaskView('board')}
                >
                  看板
                </Button>
              </div>
            )}
            {section === 'tasks' && (
              <div className="zm-filter zm-task-filters">
                <input
                  aria-label="搜索任务"
                  placeholder="搜索任务…"
                  maxLength={200}
                  value={taskFilters.search}
                  onChange={(e) => setTaskFilters({ ...taskFilters, search: e.target.value })}
                />
                <SingleSelect
                  label="筛选参与者"
                  value={participantFilter}
                  popupMinWidth={240}
                  onValueChange={(participantId) =>
                    setTaskFilters({ ...taskFilters, participantId })
                  }
                  options={[
                    { value: '', label: '所有参与者' },
                    ...state.participants.map((person) => ({
                      value: person.id,
                      label: `${person.name} · ${person.kind === 'expert' ? 'Agent 专家' : '成员'}`,
                    })),
                  ]}
                />
                <SingleSelect
                  label="筛选阶段"
                  value={taskFilters.stage}
                  popupMinWidth={200}
                  onValueChange={(stage) =>
                    setTaskFilters({ ...taskFilters, stage: stage as typeof taskFilters.stage })
                  }
                  options={[
                    { value: '', label: '所有阶段' },
                    ...taskBoardColumns.map((column) => ({
                      value: column.id,
                      label: `${column.label} · ${taskCandidates.filter((task) => stageFor(task) === column.id).length}`,
                    })),
                  ]}
                />
                <SingleSelect
                  label="筛选项目"
                  value={projectFilter}
                  onValueChange={setProjectFilter}
                  options={[
                    { value: '', label: '所有项目' },
                    ...state.projects.map((p) => ({ value: p.id, label: p.name })),
                  ]}
                />
                <div className="zm-task-filter-summary" role="status">
                  <span>
                    {tasks.length} / {state.tasks.length} 项任务
                    {stageLoading ? ' · 正在读取阶段…' : ''}
                  </span>
                  {(projectFilter ||
                    participantFilter ||
                    taskFilters.stage ||
                    taskFilters.search) && (
                    <Button
                      variant="quiet"
                      onClick={() => setTaskFilters({ ...emptyTaskFilters, view: taskView })}
                    >
                      清除筛选
                    </Button>
                  )}
                </div>
              </div>
            )}
            {section !== 'tasks' && section !== 'knowledge' && !activeProject && (
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
                  <SingleSelect
                    label="成员类型"
                    value={memberKind}
                    onValueChange={setMemberKind}
                    options={[
                      { value: 'all', label: '所有成员与专家' },
                      { value: 'human', label: '团队成员' },
                      { value: 'expert', label: 'Agent 专家' },
                    ]}
                  />
                )}
              </div>
            )}
          </div>
        )}
        {section === 'knowledge' && knowledge && (
          <KnowledgePanel {...knowledge} onDirtyChange={setKnowledgeDirty} />
        )}
        {!expertLibrary && section === 'assets' && (
          <nav className="zm-asset-categories" aria-label="资产分类">
            {[
              ['all', '全部'],
              ['template', '工作流'],
              ['expert', 'Agent 专家'],
              ['skill', 'Skills'],
              ['mcp', 'MCP'],
            ].map(([kind, label]) => {
              const count =
                kind === 'all'
                  ? catalogMatches.length
                  : catalogMatches.filter((a) => a.kind === kind).length;
              return (
                <Button
                  key={kind}
                  variant="quiet"
                  aria-label={`${label} ${count}`}
                  aria-pressed={assetKind === kind}
                  onClick={() => setAssetKind(kind!)}
                >
                  {label}
                  <span>{count}</span>
                </Button>
              );
            })}
          </nav>
        )}
        {error && (
          <div role="alert" className="zm-error">
            {error}
          </div>
        )}
        {expertLibrary && (
          <ExpertBrowser
            experts={state.participants.filter((p) => p.kind === 'expert')}
            assets={state.assets}
            view={expertView}
            change={setExpertView}
            edit={(value) => openDialog({ kind: 'member', value })}
            source={(value) =>
              value.origin &&
              setSourceDialog({
                kind: 'expert',
                id: value.id,
                name: value.name,
                versionId: value.origin.versionId,
              })
            }
          />
        )}
        {activeProject && (
          <ProjectHub
            key={activeProject.id}
            project={activeProject}
            state={state}
            tab={projectTab}
            changeTab={(tab) => {
              if (tab !== projectTab) leaveKnowledge(() => setProjectTab(tab));
            }}
            openTask={(id) => leaveKnowledge(() => setActiveTaskId(id))}
            createTask={() => leaveKnowledge(() => newTask(activeProject.id))}
            edit={() => openDialog({ kind: 'project', value: activeProject })}
            canCreateTask={!member || capabilities?.createTask === true}
            canEdit={!member || capabilities?.createProject === true}
            resourcesConnected={!member || capabilities?.resources === 'authorized'}
            projectExecution={projectExecution?.api}
            spaceId={projectExecution?.spaceId}
            taskProgress={progressFor}
            {...(knowledge?.projectApi
              ? {
                  knowledge: {
                    scope: {
                      actorId: knowledge.actorId,
                      spaceId: knowledge.spaceId,
                      projectId: activeProject.id,
                    },
                    api: knowledge.projectApi,
                    isCurrent: () => knowledge.lifetime.isCurrent(),
                    onDirtyChange: setProjectKnowledgeDirty,
                  },
                }
              : {})}
          />
        )}
        {section === 'projects' && !activeProject && !!projects.length && (
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
                      setActiveProjectId(p.id);
                      setProjectTab('overview');
                      setSearch('');
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
                  <Button
                    variant="quiet"
                    disabled={!!member && !capabilities?.createProject}
                    onClick={() => openDialog({ kind: 'project', value: p })}
                  >
                    编辑
                  </Button>
                  <Button
                    disabled={!!member && !capabilities?.createTask}
                    onClick={() => {
                      setActiveProjectId(p.id);
                      setProjectTab('work');
                      setSearch('');
                      newTask(p.id);
                    }}
                  >
                    创建任务
                  </Button>
                </div>
              </article>
            ))}
          </div>
        )}
        {section === 'tasks' && (
          <>
            {taskView === 'board' ? (
              <TaskBoard
                tasks={tasks}
                projects={state.projects}
                participants={state.participants}
                progress={progressFor}
                confirmed={(id) => state.appliedPlans.some((plan) => plan.taskId === id)}
                openTask={setActiveTaskId}
              />
            ) : (
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
                        .map((p) => {
                          const avatarLabel = `${p.name} · ${p.kind === 'expert' ? 'Agent 专家' : '团队成员'}（参与者）`;
                          return (
                            <span
                              role="img"
                              title={avatarLabel}
                              aria-label={avatarLabel}
                              className={`zm-avatar ${p.kind}`}
                              key={p.id}
                            >
                              {p.kind === 'expert' ? 'AI' : p.name[0]}
                            </span>
                          );
                        })}
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
                    <span className="zm-task-state-cell">
                      <TaskProgressSummary
                        progress={progressFor(t.id)}
                        confirmed={state.appliedPlans.some((plan) => plan.taskId === t.id)}
                        compact
                      />
                      <span className={`zm-status ${t.status}`}>
                        {t.status === 'draft' ? '计划草稿' : '计划已确认'}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            {!tasks.length && (
              <div className="zm-empty">
                <h3>
                  {stageLoading
                    ? '正在读取任务阶段…'
                    : state.tasks.length
                      ? '没有匹配的任务'
                      : '开始下一项工作'}
                </h3>
                <p>
                  {state.tasks.length
                    ? '换个关键词，或清除筛选查看全部任务。'
                    : '创建任务后，选择参与者，再由 AI 或你自己编排工作流。'}
                </p>
                {!state.tasks.length && (
                  <button onClick={() => newTask()} className="primary" disabled={!canCreate}>
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
        {!expertLibrary && section === 'assets' && !!assets.length && (
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
                  {a.kind === 'template'
                    ? '工作流模板'
                    : a.kind === 'expert'
                      ? 'Agent 专家'
                      : a.kind === 'skill'
                        ? 'Skill'
                        : 'MCP'}
                </span>
                <div className="zm-directory-content">
                  <h3>{a.name}</h3>
                  <p title={a.description}>{a.description || '暂无用途说明'}</p>
                </div>
                <span className={`zm-availability ${a.available ? '' : 'unavailable'}`}>
                  {a.origin?.missing.length ? '待补齐' : a.available ? '已启用' : '已停用'}
                </span>
                <div className="zm-directory-actions">
                  {a.origin && (
                    <Button
                      variant="quiet"
                      onClick={() =>
                        setSourceDialog({
                          kind: a.expert ? 'expert' : 'asset',
                          id: a.id,
                          name: a.name,
                          versionId: a.origin!.versionId,
                        })
                      }
                    >
                      来源
                    </Button>
                  )}
                  <Button
                    variant="quiet"
                    onClick={() =>
                      a.expert
                        ? openDialog({ kind: 'member', value: a.expert })
                        : a.asset && openDialog({ kind: 'asset', value: a.asset })
                    }
                  >
                    编辑
                  </Button>
                </div>
              </article>
            ))}
          </div>
        )}
        {!expertLibrary &&
          !activeProject &&
          section !== 'tasks' &&
          section !== 'knowledge' &&
          !visibleCount && (
            <div className="zm-empty zm-directory-empty">
              <h3>{directoryTotal ? `没有匹配的${labels[section]}` : `暂无${labels[section]}`}</h3>
              <p>
                {directoryTotal
                  ? '换个关键词，或清除筛选。'
                  : section === 'projects'
                    ? '创建项目，集中管理相关工作。'
                    : section === 'members'
                      ? '添加团队成员或 Agent 专家，填写职责后参与分工。'
                      : '新建或导入专家、Skill、MCP 能力定义和工作流模板。'}
              </p>
              {directoryTotal ? (
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
                <Button variant="primary" onClick={createCatalogItem} disabled={!canCreate}>
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
          close={() => !saving && closeDialog()}
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
              if (d.kind === 'asset') {
                if (d.value.kind === 'template' && !d.value.content.trim()) {
                  setDialogError('请先编排工作流，再保存模板。');
                  return;
                }
                void submit({ type: 'save-asset', asset: d.value });
              }
              if (d.kind === 'task') void createTask(d);
            }}
          >
            <div className="zm-form-body">
              <fieldset className="zm-form-fields" disabled={saving}>
                {dialog.kind === 'project' && (
                  <>
                    {taskAfterProject && (
                      <p className="zm-project-task-context">保存项目后继续创建任务。</p>
                    )}
                    <ProjectFields
                      project={dialog.value}
                      state={state}
                      change={(value) => setDialog({ ...dialog, value })}
                    />
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
                        <SingleSelect
                          label="类型"
                          value={dialog.value.kind}
                          disabled={expertLibrary || !!dialog.value.origin}
                          onValueChange={(kind) =>
                            setDialog({
                              ...dialog,
                              value: { ...dialog.value, kind: kind as Participant['kind'] },
                            })
                          }
                          options={[
                            { value: 'human', label: '团队成员' },
                            { value: 'expert', label: 'Agent 专家' },
                          ]}
                        />
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
                        maxLength={dialog.value.kind === 'expert' ? 32000 : 8000}
                        readOnly={!!dialog.value.origin}
                        value={dialog.value.instructions}
                        onChange={(e) =>
                          setDialog({
                            ...dialog,
                            value: { ...dialog.value, instructions: e.target.value },
                          })
                        }
                      />
                    </Field>
                    {dialog.value.kind === 'expert' && (
                      <>
                        {originInfo(dialog.value, 'expert')}
                        <details className="zm-config-group">
                          <summary>默认能力</summary>
                          <MultiSelect
                            label="Skills"
                            options={state.assets.filter((a) => a.kind === 'skill')}
                            selected={dialog.value.resourceBindings?.skillIds ?? []}
                            change={(skillIds) =>
                              setDialog({
                                ...dialog,
                                value: {
                                  ...dialog.value,
                                  resourceBindings: {
                                    skillIds,
                                    mcpIds: dialog.value.resourceBindings?.mcpIds ?? [],
                                  },
                                },
                              })
                            }
                          />
                          <MultiSelect
                            label="MCP"
                            options={state.assets.filter((a) => a.kind === 'mcp')}
                            selected={dialog.value.resourceBindings?.mcpIds ?? []}
                            change={(mcpIds) =>
                              setDialog({
                                ...dialog,
                                value: {
                                  ...dialog.value,
                                  resourceBindings: {
                                    mcpIds,
                                    skillIds: dialog.value.resourceBindings?.skillIds ?? [],
                                  },
                                },
                              })
                            }
                          />
                        </details>
                      </>
                    )}
                    <label className="zm-check-row">
                      <input
                        type="checkbox"
                        checked={dialog.value.available}
                        disabled={!!dialog.value.origin?.missing.length}
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
                        <SingleSelect
                          label="类型"
                          value={dialog.value.kind}
                          disabled={!!dialog.value.origin}
                          onValueChange={(kind) =>
                            setDialog({
                              ...dialog,
                              value: { ...dialog.value, kind: kind as TeamAsset['kind'] },
                            })
                          }
                          options={[
                            { value: 'skill', label: 'Skill' },
                            { value: 'mcp', label: 'MCP 能力定义' },
                            { value: 'template', label: '工作流模板' },
                          ]}
                        />
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
                    {dialog.value.kind === 'template' ? (
                      <section className="zm-template-asset-definition">
                        <div>
                          <strong>
                            {assetDefinition
                              ? `${assetDefinition.workflows.flatMap((w) => w.nodes).length} 个节点 · ${assetDefinition.roles.length} 个角色`
                              : dialog.value.content
                                ? '文字模板，尚未包含工作流结构'
                                : '编排可复用的工作流'}
                          </strong>
                          <Button
                            disabled={!!dialog.value.origin}
                            onClick={() => setDefinitionEditorOpen(true)}
                          >
                            {assetDefinition
                              ? '编辑工作流'
                              : dialog.value.content
                                ? '转换为工作流'
                                : '编排工作流'}
                          </Button>
                        </div>
                        {assetDefinition ? (
                          <small>节点、依赖、角色和评审将在复用时完整保留。</small>
                        ) : (
                          dialog.value.content && (
                            <details>
                              <summary>查看原文字</summary>
                              <pre>{dialog.value.content}</pre>
                            </details>
                          )
                        )}
                      </section>
                    ) : (
                      <Field label="定义内容">
                        <textarea
                          rows={8}
                          maxLength={dialog.value.kind === 'skill' ? 60000 : 8000}
                          readOnly={!!dialog.value.origin}
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
                    )}
                    {originInfo(dialog.value, 'asset')}
                    <label className="zm-check-row">
                      <input
                        type="checkbox"
                        checked={dialog.value.available}
                        disabled={!!dialog.value.origin?.missing.length}
                        onChange={(e) =>
                          setDialog({
                            ...dialog,
                            value: { ...dialog.value, available: e.target.checked },
                          })
                        }
                      />
                      {dialog.value.kind === 'template' ? '允许复用此工作流' : '可用于规划'}
                    </label>
                  </>
                )}
                {dialog.kind === 'task' && (
                  <>
                    <Field label="任务目标">
                      <textarea
                        required
                        autoFocus
                        className="zm-create-goal"
                        rows={5}
                        maxLength={8000}
                        value={dialog.value.goal}
                        onChange={(e) =>
                          setDialog({ ...dialog, value: { ...dialog.value, goal: e.target.value } })
                        }
                        placeholder="这次要完成什么？描述目标与预期结果…"
                      />
                    </Field>
                    <div className="zm-creation-context">
                      <div className="zm-task-project-choice">
                        <div className="zm-creation-field-heading">
                          <span>所属项目</span>
                          {!!state.projects.length && (!member || capabilities?.createProject) && (
                            <Button variant="quiet" onClick={() => createProjectForTask(dialog)}>
                              新建项目
                            </Button>
                          )}
                        </div>
                        {state.projects.length ? (
                          <SingleSelect
                            label="所属项目"
                            value={dialog.value.projectId}
                            onValueChange={(projectId) =>
                              setDialog({ ...dialog, value: { ...dialog.value, projectId } })
                            }
                            options={state.projects.map((p) => ({ value: p.id, label: p.name }))}
                          />
                        ) : (
                          <span className="zm-project-needed">尚无项目</span>
                        )}
                      </div>
                      <div className="zm-creation-participants">
                        <div className="zm-creation-field-heading">
                          <span>参与者 · {dialog.value.participantIds.length} 位</span>
                          {state.projects.find((p) => p.id === dialog.value.projectId)
                            ?.defaultParticipantIds !== undefined && (
                            <Button
                              variant="quiet"
                              aria-label="使用项目默认参与者"
                              onClick={() =>
                                changeTaskParticipants(
                                  initialParticipants(
                                    state.projects.find((p) => p.id === dialog.value.projectId),
                                    state,
                                  ),
                                )
                              }
                            >
                              使用项目默认
                            </Button>
                          )}
                        </div>
                        <ParticipantSelect
                          label="参与者"
                          multiple
                          members={state.participants}
                          selected={dialog.value.participantIds}
                          change={changeTaskParticipants}
                        />
                      </div>
                    </div>
                    {member && <PlanningReadiness value={planningReadiness} />}
                    <fieldset className="zm-create-modes">
                      <legend>规划方式</legend>
                      <label>
                        <input
                          type="radio"
                          name="planning-mode"
                          value="ai"
                          disabled={
                            !!member &&
                            (!capabilities?.planning ||
                              (dialog.value.ownerId !== null &&
                                dialog.value.ownerId !== member.actorId))
                          }
                          checked={dialog.planning === 'ai'}
                          onChange={() => setDialog({ ...dialog, planning: 'ai' })}
                        />
                        <span>
                          <strong>AI 规划</strong>
                        </span>
                      </label>
                      {(!member ||
                        state.assets.some(
                          (asset) => asset.kind === 'template' && asset.available,
                        )) && (
                        <label>
                          <input
                            type="radio"
                            name="planning-mode"
                            value="template"
                            checked={dialog.planning === 'template'}
                            onChange={() => {
                              setDialog({ ...dialog, planning: 'template' });
                              if (!dialog.template) setTemplateBrowserOpen(true);
                            }}
                          />
                          <span>
                            <strong>使用工作流</strong>
                          </span>
                        </label>
                      )}
                      <label>
                        <input
                          type="radio"
                          name="planning-mode"
                          value="manual"
                          checked={dialog.planning === 'manual'}
                          onChange={() => setDialog({ ...dialog, planning: 'manual' })}
                        />
                        <span>
                          <strong>从空白开始</strong>
                        </span>
                      </label>
                    </fieldset>
                    {dialog.planning === 'template' && (
                      <section className="zm-template-creation">
                        <div className="zm-template-chosen">
                          <div>
                            <strong>{selectedTemplate?.name ?? '选择可复用的工作流'}</strong>
                            {selectedDefinition && (
                              <small>
                                {selectedDefinition.workflows.flatMap((w) => w.nodes).length} 个节点
                                · {selectedDefinition.roles.length} 个角色
                              </small>
                            )}
                          </div>
                          <Button onClick={() => setTemplateBrowserOpen(true)}>
                            {dialog.template ? '更换' : '选择工作流'}
                          </Button>
                        </div>
                        {dialog.template && selectedDefinition && (
                          <TemplateBindings
                            roles={selectedDefinition.roles}
                            resources={selectedDefinition.resources}
                            members={state.participants.filter((p) =>
                              dialog.value.participantIds.includes(p.id),
                            )}
                            assets={state.assets}
                            roleValues={dialog.template.roles}
                            resourceValues={dialog.template.resources}
                            changeRoles={(roles) =>
                              setDialog({ ...dialog, template: { ...dialog.template!, roles } })
                            }
                            changeResources={(resources) =>
                              setDialog({ ...dialog, template: { ...dialog.template!, resources } })
                            }
                          />
                        )}
                      </section>
                    )}
                    <Field label="任务名称">
                      <input
                        maxLength={160}
                        value={dialog.value.title}
                        onChange={(e) =>
                          setDialog({
                            ...dialog,
                            value: { ...dialog.value, title: e.target.value },
                          })
                        }
                        placeholder="可选，留空时从目标生成"
                      />
                    </Field>
                    <ParticipantSelect
                      label="任务负责人"
                      members={state.participants.filter(
                        (p) => p.kind === 'human' && dialog.value.participantIds.includes(p.id),
                      )}
                      selected={dialog.value.ownerId ? [dialog.value.ownerId] : []}
                      change={(ids) =>
                        setDialog({
                          ...dialog,
                          planning:
                            member && ids[0] !== member.actorId ? 'manual' : dialog.planning,
                          value: { ...dialog.value, ownerId: ids[0] ?? null },
                        })
                      }
                    />
                    {!dialog.value.ownerId && <small>确认工作流前需指定负责人。</small>}
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
              <Button disabled={saving} onClick={closeDialog}>
                取消
              </Button>
              <Button
                type={
                  dialog.kind === 'task' &&
                  (!dialog.value.projectId || (dialog.planning === 'template' && !dialog.template))
                    ? 'button'
                    : 'submit'
                }
                onClick={() => {
                  if (dialog.kind !== 'task') return;
                  if (!dialog.value.projectId) createProjectForTask(dialog);
                  else if (dialog.planning === 'template' && !dialog.template)
                    setTemplateBrowserOpen(true);
                }}
                variant="primary"
                busy={saving}
                busyLabel="正在保存…"
              >
                {dialog.kind === 'task'
                  ? !dialog.value.projectId
                    ? '先创建项目'
                    : dialog.planning === 'ai'
                      ? '生成计划'
                      : dialog.planning === 'template' && !dialog.template
                        ? '选择工作流'
                        : dialog.planning === 'template' &&
                            (Object.values(dialog.template!.roles).some((v) => !v) ||
                              Object.values(dialog.template?.resources ?? {}).some((v) => !v))
                          ? '保存草稿'
                          : '创建工作流'
                  : '保存'}
              </Button>
            </footer>
          </form>
        </Modal>
      )}
      {templateBrowserOpen && dialog?.kind === 'task' && (
        <TemplateBrowser
          assets={state.assets}
          selectedId={dialog.template?.assetId ?? null}
          close={() => setTemplateBrowserOpen(false)}
          choose={(asset) => {
            const definition = parseWorkflowTemplate(asset.content);
            setDialog({
              ...dialog,
              planning: 'template',
              template: {
                assetId: asset.id,
                roles: Object.fromEntries(definition.roles.map((r) => [r.id, null])),
                resources: Object.fromEntries(
                  definition.resources.map((r) => [
                    r.id,
                    state.assets.some(
                      (a) => a.id === r.suggestedAssetId && a.kind === r.kind && a.available,
                    )
                      ? r.suggestedAssetId!
                      : null,
                  ]),
                ),
              },
            });
            setTemplateBrowserOpen(false);
          }}
        />
      )}
      {definitionEditorOpen && dialog?.kind === 'asset' && (
        <TemplateDefinitionEditor
          content={dialog.value.content}
          state={state}
          close={() => setDefinitionEditorOpen(false)}
          apply={(content) => {
            setDialog({ ...dialog, value: { ...dialog.value, content } });
            setDefinitionEditorOpen(false);
          }}
        />
      )}
      {importOpen && (
        <AssetImportDialog
          state={state}
          api={api}
          requireExpert={expertLibrary}
          close={() => setImportOpen(false)}
          saved={(next) => {
            if (expertLibrary) {
              const imported = next.participants.find(
                (p) =>
                  p.kind === 'expert' &&
                  JSON.stringify(p) !==
                    JSON.stringify(state.participants.find((old) => old.id === p.id)),
              );
              setExpertView({
                search: '',
                role: '',
                selectedId: imported?.id ?? expertView.selectedId,
              });
            }
            setState(next);
            setImportOpen(false);
          }}
          legacy={(name, content) => {
            setImportOpen(false);
            if (assetKind === 'expert')
              openDialog({
                kind: 'member',
                value: {
                  id: uid(),
                  name,
                  kind: 'expert',
                  role: '',
                  capabilities: [],
                  instructions: content,
                  available: true,
                },
              });
            else
              openDialog({
                kind: 'asset',
                value: {
                  id: uid(),
                  name,
                  kind:
                    assetKind === 'template' ? 'template' : assetKind === 'mcp' ? 'mcp' : 'skill',
                  description: '',
                  content,
                  available: true,
                },
              });
          }}
        />
      )}
      {sourceDialog && (
        <ResourceSourceDialog {...sourceDialog} api={api} close={() => setSourceDialog(null)} />
      )}
    </div>
  );
}
