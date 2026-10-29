/** Synthetic authorized catalog for contracts; never a product catalog grant. */
import { randomUUID } from 'node:crypto';
import { emptyWorkbench } from '@zhuma/agent-core';
import { node, request, setup } from './member-workbench-fixture.mjs';

export const definition = {
  format: 'zhuma-workflow-template',
  schemaVersion: 1,
  roles: [
    { id: 'author', name: '执行者', preferredKind: 'human', capabilities: [] },
    { id: 'reviewer', name: '独立评审', preferredKind: 'human', capabilities: [] },
  ],
  resources: [{ id: 'method', name: '检查方法', kind: 'skill' }],
  workflows: [
    {
      id: 'source-root',
      name: '主流程',
      parentNodeId: null,
      nodes: [
        node('source-write', {
          assigneeId: 'author',
          reviewRequired: true,
          reviewerIds: ['reviewer'],
          skillIds: ['method'],
        }),
        node('source-deliver', { assigneeId: 'author', dependsOn: ['source-write'] }),
      ],
    },
    {
      id: 'source-child',
      name: '补充材料',
      parentNodeId: 'source-write',
      nodes: [node('source-detail', { assigneeId: 'author' })],
    },
  ],
};
export const template = () => ({
  id: 'authorized-template',
  name: '有权工作流',
  kind: 'template',
  description: '',
  available: true,
  content: JSON.stringify(definition),
});
export const skill = () => ({
  id: 'authorized-skill',
  name: '检查方法',
  kind: 'skill',
  description: '',
  available: true,
  content: '核对真实输入和交付结果。',
});
export const catalog = () => ({ experts: [], assets: [template(), skill()] });
export const instance = (revision = 0, patch = {}, spaceId = 'north') =>
  request(
    revision,
    {
      type: 'instantiate-template',
      input: {
        templateId: 'authorized-template',
        task: {
          id: randomUUID(),
          projectId: 'project-one',
          title: '独立实例',
          goal: '交付接口说明',
          participantIds: ['ann', 'bob'],
          ownerId: 'ann',
        },
        roleBindings: { author: 'ann', reviewer: 'bob' },
        resourceBindings: { method: 'authorized-skill' },
        ...patch,
      },
    },
    spaceId,
  );
export function fixture(options = {}) {
  const state = emptyWorkbench();
  state.projects.push({ id: 'project-one', name: '接口项目', description: '' });
  // An unrelated legacy asset must never become member authority.
  state.assets.push({ ...template(), id: 'legacy-private', content: JSON.stringify(definition) });
  return setup({
    state,
    projectSpaces: [['project-one', 'north']],
    service: {
      catalog: async (spaceId) => (spaceId === 'north' ? catalog() : { experts: [], assets: [] }),
    },
    ...options,
  });
}
