import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createAgentWorkspaceView } from '../../packages/client/dist/index.js';
import {
  DshChatExecutor,
  ExecutionDesk,
  SimulatedAgentExecutor,
  UnimplementedNativeExecutor,
  createFileJournal,
  createWorkbenchServer,
  probeRelativeFile,
  readDshModelConfig,
  resolveDshBinary,
} from '../../packages/dsh-adapter/dist/index.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(root, 'fixture');
const hold = process.env.ZHUMA_HOLD_RUNS === '1';
const dataDir =
  process.env.ZHUMA_DATA_DIR ??
  (process.env.ZHUMA_SESSION_FILE
    ? path.dirname(process.env.ZHUMA_SESSION_FILE)
    : path.join(homedir(), '.zhuma', 'workbench'));
const sessionFile =
  process.env.ZHUMA_SESSION_FILE ?? path.join(dataDir, `session-${process.pid}.json`);

let sequence = 0;
function newId(prefix) {
  sequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${sequence}`;
}

const dshConfig = readDshModelConfig(process.env);
const dshBinary = resolveDshBinary(process.env);
const dshReady = dshConfig.ok && dshBinary !== null;
const dshReason = dshConfig.ok
  ? dshBinary === null
    ? '没有找到 DSH 运行时。请运行 pnpm upstream:build-dsh，或设置 ZHUMA_DSH_BIN。还需要 ZHUMA_MODEL_BASE_URL、ZHUMA_MODEL_API_KEY 和 ZHUMA_MODEL_ID。'
    : undefined
  : dshConfig.reason;

const seed = {
  handoff: {
    nodeId: 'node-fields',
    taskId: 'task-portal',
    workflowVersionId: 'plan-1',
    revision: 3,
    goal: '确认企业开户字段与校验规则',
    assignee: { id: 'chen-ning', kind: 'human' },
    dependencyNodeIds: [],
    reviewRequired: true,
    reviewerIds: ['lin-ke'],
    inputRefs: [
      { sourceNodeId: 'node-goal', artifactVersionId: 'av-goal', contextPackId: 'pack-goal' },
      { sourceNodeId: 'node-parent', artifactVersionId: 'av-parent', contextPackId: 'pack-parent' },
      { sourceNodeId: 'node-input', artifactVersionId: 'av-input', contextPackId: 'pack-input' },
      { sourceNodeId: 'node-glossary', artifactVersionId: 'av-glossary' },
      { sourceNodeId: 'node-spec', artifactVersionId: 'av-spec', contextPackId: 'pack-spec' },
      { sourceNodeId: 'node-review', artifactVersionId: 'av-review', contextPackId: 'pack-review' },
    ],
    expertRef: { id: 'api-impl', version: 'api-impl-v1' },
    skillRefs: [
      { id: 'test-design', version: '1' },
      { id: 'review-code', version: '1' },
      { id: 'skill-office', version: '1' },
    ],
    mcpRefs: [
      { id: 'api-docs', version: '1' },
      { id: 'issue-search', version: '1' },
    ],
    inputNote: '',
    expectedOutput: '',
  },
  taskTitle: '企业客户门户季度交付',
  taskGoal: '完成企业客户开户闭环',
  actorId: 'chen-ning',
  nodeStatus: 'ready',
  fileRoot: fixtureRoot,
  catalog: {
    experts: [
      {
        id: 'api-impl',
        versionId: 'api-impl-v1',
        label: '接口实现',
        summary: '整理接口字段与校验',
        enabled: true,
        presetSkillIds: ['test-design'],
        presetMcpIds: ['api-docs'],
        toolAllowlist: [],
      },
      {
        id: 'reviewer',
        versionId: 'reviewer-v2',
        label: '评审专家',
        summary: '核对交付说明',
        enabled: true,
        presetSkillIds: [],
        presetMcpIds: [],
      },
      {
        id: 'retired',
        versionId: 'retired-v1',
        label: '停用专家',
        summary: '不可用',
        enabled: false,
        unavailableReason: '专家已停用',
        presetSkillIds: [],
        presetMcpIds: [],
      },
    ],
    skills: [
      {
        id: 'test-design',
        version: '1',
        label: '测试设计',
        available: true,
        description: '为开户字段设计校验用例',
        body: '按字段清单列出必填、格式和校验位用例。',
      },
      {
        id: 'review-code',
        version: '1',
        label: '代码审阅',
        available: true,
        description: '核对接口字段与校验是否一致',
        body: '对照字段规范检查命名、必填和校验位。',
      },
      {
        id: 'legacy',
        version: '1',
        label: '旧检索',
        available: false,
        unavailableReason: '资产已停用',
      },
      {
        id: 'skill-office',
        version: '1',
        label: 'Office 文档',
        available: true,
        description: '处理文档、表格和演示',
        body: '当前构建没有 Office 技能文件时不会加载。',
      },
    ],
    mcp: [
      { id: 'api-docs', version: '1', label: '接口文档只读', available: true },
      { id: 'issue-search', version: '1', label: '工单检索', available: true },
      {
        id: 'billing',
        version: '1',
        label: '账单工具',
        available: false,
        unavailableReason: '当前任务没有工具授权',
      },
    ],
    executors: [
      {
        id: 'simulated',
        label: '模拟执行器',
        available: true,
        verified: false,
        simulated: true,
      },
      {
        id: 'dsh',
        label: 'DSH',
        available: dshReady,
        verified: dshReady,
        simulated: false,
        ...(dshReason === undefined ? {} : { unavailableReason: dshReason }),
      },
      {
        id: 'codearts-cli',
        label: '码道',
        available: false,
        verified: false,
        simulated: false,
        unavailableReason: '尚未实现，也未验证',
      },
    ],
  },
  contextItems: [
    {
      id: 'goal',
      kind: 'goal',
      sourceId: 'task-portal',
      version: '3',
      permission: 'granted',
      summary: '确认企业开户字段与校验规则',
      required: true,
      includedByDefault: true,
      sourceNodeId: 'node-goal',
      artifactVersionId: 'av-goal',
      contextPackId: 'pack-goal',
      body: '确认企业开户字段与校验规则',
    },
    {
      id: 'parent',
      kind: 'parent-goal',
      sourceId: 'task-parent',
      version: '1',
      permission: 'granted',
      summary: '企业客户门户季度交付',
      required: true,
      includedByDefault: true,
      sourceNodeId: 'node-parent',
      artifactVersionId: 'av-parent',
      contextPackId: 'pack-parent',
      body: '企业客户门户季度交付',
    },
    {
      id: 'input',
      kind: 'node-input',
      sourceId: 'node-fields-input',
      version: '1',
      permission: 'granted',
      summary: '本节点输入：开户字段清单',
      required: true,
      includedByDefault: true,
      sourceNodeId: 'node-input',
      artifactVersionId: 'av-input',
      contextPackId: 'pack-input',
      body: '本节点输入：开户字段清单',
    },
    {
      id: 'upstream',
      kind: 'accepted-upstream-artifact',
      sourceId: 'artifact-glossary',
      version: '2',
      permission: 'granted',
      summary: '已接受的上游术语表',
      required: false,
      includedByDefault: true,
      sourceNodeId: 'node-glossary',
      artifactVersionId: 'av-glossary',
      body: '已接受的上游术语表',
    },
    {
      id: 'knowledge',
      kind: 'project-knowledge',
      sourceId: '开户字段规范',
      version: '1',
      permission: 'granted',
      summary: '开户字段规范',
      required: true,
      includedByDefault: true,
      relativePath: '开户字段规范.md',
      sourceNodeId: 'node-spec',
      artifactVersionId: 'av-spec',
      contextPackId: 'pack-spec',
    },
    {
      id: 'review',
      kind: 'review-comment',
      sourceId: 'round-old',
      version: '1',
      permission: 'granted',
      summary: '上一轮评审：统一社会信用代码需要校验位',
      required: false,
      includedByDefault: true,
      sourceNodeId: 'node-review',
      artifactVersionId: 'av-review',
      contextPackId: 'pack-review',
      body: '上一轮评审：统一社会信用代码需要校验位',
    },
    {
      id: 'missing',
      kind: 'project-knowledge',
      sourceId: '外部映射表',
      version: '9',
      permission: 'granted',
      summary: '外部映射表',
      required: false,
      includedByDefault: false,
      relativePath: '外部映射表.csv',
    },
  ],
  reviewRounds: [{ id: 'round-old', status: 'changes-requested' }],
};

const journal = createFileJournal(sessionFile);
const saved = journal.load();
if (journal.writable === false && saved === null) {
  process.stderr.write(
    journal.refusal ? `${journal.refusal}\n` : '另一个进程正持有这份会话的写权，本次启动已拒绝。\n',
  );
  process.exit(1);
}
const dependencies = {
  executors: [
    new SimulatedAgentExecutor(
      hold
        ? { pauseBeforeAccept: true, pauseAfterAccept: true, chunkDelayMs: 0 }
        : { chunkDelayMs: 70 },
    ),
    new DshChatExecutor(process.env, {
      dataDir: path.dirname(sessionFile),
      sweepOrphans: true,
    }),
    new UnimplementedNativeExecutor('codearts-cli'),
  ],
  newId,
  probe: (relativePath) => probeRelativeFile(fixtureRoot, relativePath),
  journal,
};
const desk = saved
  ? ExecutionDesk.restore(saved, dependencies)
  : ExecutionDesk.create(seed, dependencies);
const server = createWorkbenchServer({
  desk,
  present: createAgentWorkspaceView,
  publicDir: path.join(root, 'public'),
});
const port = Number(process.env.PORT || 0);
server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  const actual = address && typeof address === 'object' ? address.port : port;
  process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${actual}` })}\n`);
});
