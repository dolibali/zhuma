import { taskInput, node } from './member-workbench-fixture.mjs';

export function catalogFixture() {
  const expert = {
    id: 'authorized-agent',
    name: '接口 Agent',
    kind: 'expert',
    role: '接口分析',
    capabilities: ['API'],
    instructions: 'OLD_AUTHORIZED_EXPERT',
    available: true,
  };
  const skill = {
    id: 'authorized-skill',
    name: '接口规范',
    kind: 'skill',
    description: '',
    content: 'OLD_AUTHORIZED_SKILL',
    available: true,
  };
  const mcp = {
    id: 'authorized-mcp',
    name: '接口工具',
    kind: 'mcp',
    description: '',
    content: 'OLD_AUTHORIZED_MCP',
    available: true,
  };
  return { experts: [expert], assets: [skill, mcp] };
}
export function catalogTask() {
  return taskInput({
    participantIds: ['ann', 'authorized-agent'],
    workflows: [
      {
        id: 'root',
        name: '接口',
        parentNodeId: null,
        nodes: [
          node('write', {
            assigneeId: 'authorized-agent',
            skillIds: ['authorized-skill'],
            mcpIds: ['authorized-mcp'],
          }),
        ],
      },
    ],
  });
}

export function changedCatalog(catalog, kind, change = 'content') {
  const next = structuredClone(catalog);
  const resource = kind === 'expert' ? next.experts[0] : next.assets.find((a) => a.kind === kind);
  if (change === 'revoke') {
    if (kind === 'expert') next.experts = [];
    else next.assets = next.assets.filter((a) => a.kind !== kind);
  } else if (change === 'disable') resource.available = false;
  else if (change === 'version') {
    resource.origin = {
      versionId: '00000000-0000-4000-8000-000000000002',
      format: kind === 'expert' ? 'zhuma-expert' : 'agent-skill',
      entryPath: 'definition.md',
      filePaths: ['definition.md'],
      totalBytes: 30,
      missing: [],
      sourceVersion: '2',
    };
  } else if (kind === 'expert') resource.instructions = 'NEW_AUTHORIZED_EXPERT';
  else resource.content = `NEW_AUTHORIZED_${kind}`;
  return next;
}

export function catalogForMode(mode) {
  const original = catalogFixture();
  if (mode === 'old') return original;
  const [kind, change = 'content'] = mode.split(':');
  return changedCatalog(original, kind, change);
}
