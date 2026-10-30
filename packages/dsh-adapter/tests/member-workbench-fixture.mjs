import { randomUUID } from 'node:crypto';
import { emptyWorkbench, WorkbenchError } from '@zhuma/agent-core';
import { WorkbenchService } from '../dist/workbench-service.js';
import { MemberWorkbenchService } from '../dist/member-workbench-service.js';
import { MemberWorkbenchOperations } from '../dist/member-workbench-operation.js';

export const people = ['ann', 'bob', 'cy', 'dana'];
export const spaces = [
  { id: 'north', kind: 'team', name: '北区' },
  { id: 'south', kind: 'team', name: '南区' },
  { id: 'personal-ann', kind: 'personal', name: '个人空间' },
];
export const memberships = [
  ['north', 'ann'],
  ['north', 'bob'],
  ['north', 'cy'],
  ['south', 'cy'],
  ['south', 'dana'],
  ['personal-ann', 'ann'],
];
export const node = (id, patch = {}) => ({
  id,
  title: '整理接口说明',
  description: '',
  assigneeId: 'ann',
  reviewerIds: [],
  reviewRequired: false,
  dependsOn: [],
  skillIds: [],
  mcpIds: [],
  input: '需求与接口',
  output: '接口文档',
  rationale: '由接口负责人处理',
  position: { x: 0, y: 0 },
  ...patch,
});
export const taskInput = (patch = {}) => ({
  id: 'task-one',
  projectId: 'project-one',
  title: '整理接口',
  goal: '确认接口与边界',
  participantIds: ['ann', 'bob'],
  ownerId: 'ann',
  workflows: [{ id: 'root', name: '接口工作流', parentNodeId: null, nodes: [node('write')] }],
  ...patch,
});
export const projectCommand = (id = 'project-one') => ({
  type: 'create-project',
  project: { id, name: '接口项目', description: '' },
});
export const request = (revision, command, spaceId = 'north', requestId = randomUUID()) => ({
  spaceId,
  requestId,
  expectedRevision: revision,
  command,
});
export const signal = () => new AbortController().signal;
export const rejected = (code) => (error) => error.code === code;
export const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

/** Service/serialization contract fixture. Not a real identity, file store, model or GUI. */
export function setup(options = {}) {
  let state = structuredClone(options.state ?? emptyWorkbench());
  let fail = false;
  let writes = 0;
  const audits = new Map();
  const intents = new Map();
  const operationStorage = {
    get: (key) => intents.get(key),
    values: () => [...intents.values()],
    put: async (key, value) => {
      intents.set(key, structuredClone(value));
    },
    delete: async (key) => {
      intents.delete(key);
    },
  };
  const operations = new MemberWorkbenchOperations(operationStorage);
  const links = new Map(options.projectSpaces ?? []);
  const grants = new Set(memberships.map(([space, actor]) => `${space}/${actor}`));
  const sessions = new Set(people);
  const directory = {
    spaces: () => structuredClone(spaces),
    space: (id) => structuredClone(spaces.find((s) => s.id === id)),
    isMember: (space, actor) => grants.has(`${space}/${actor}`),
    spacesForMember: (actor) => spaces.filter((s) => grants.has(`${s.id}/${actor}`)),
    membersForSpace: (space) =>
      people.filter((actor) => grants.has(`${space}/${actor}`)).map((id) => ({ id })),
    spaceForProject: async (id) =>
      links.has(id) ? { ok: true, spaceId: links.get(id) } : { ok: false, reason: 'unknown' },
    assignProjectSpace: async (id, space) => {
      if (links.has(id)) throw new WorkbenchError('conflict', '已归属');
      links.set(id, space);
    },
  };
  const storage = {
    read: () => state,
    write: async (next) => {
      if (fail) throw Error('synthetic disk failure');
      writes++;
      state = JSON.parse(JSON.stringify(next));
    },
  };
  const auditStorage = {
    get: (id) => audits.get(id),
    put: async (audit) => {
      audits.set(audit.id, structuredClone(audit));
    },
  };
  let workbench = new WorkbenchService(storage, auditStorage, options.packages);
  const service = (actor = 'ann', patch = {}) =>
    new MemberWorkbenchService(workbench, {
      directory: () => directory,
      writer: () => directory,
      resolve: async () =>
        sessions.has(actor)
          ? {
              ok: true,
              memberId: actor,
              spaceIds: directory.spacesForMember(actor).map((s) => s.id),
            }
          : { ok: false, status: 401, code: 'unauthenticated' },
      now: () => '2026-10-25T12:00:00.000Z',
      operations,
      ...options.service,
      ...patch,
    });
  return {
    service,
    directory,
    links,
    grants,
    sessions,
    audits,
    storage,
    auditStorage,
    intents,
    operations,
    get workbench() {
      return workbench;
    },
    get writes() {
      return writes;
    },
    failWrites(value) {
      fail = value;
    },
    reopen() {
      workbench = new WorkbenchService(storage, auditStorage, options.packages);
    },
  };
}
