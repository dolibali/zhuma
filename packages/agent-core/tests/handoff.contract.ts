import type {
  ActorRef,
  NodeHandoff,
  PayloadExcludesCredentials,
  VersionedRef,
} from '../src/handoff.js';
import type { NodeTransition } from '../src/node-status.js';

const human: NodeHandoff = {
  nodeId: 'node-1',
  taskId: 'task-1',
  workflowVersionId: 'workflow-1',
  revision: 1,
  goal: 'write the note',
  assignee: { id: 'human-1', kind: 'human' },
  dependencyNodeIds: [],
  reviewRequired: false,
  reviewerIds: [],
  inputRefs: [],
  skillRefs: [],
  mcpRefs: [],
  inputNote: '',
  expectedOutput: '',
};

const expert: NodeHandoff = {
  nodeId: 'node-2',
  taskId: 'task-1',
  workflowVersionId: 'workflow-1',
  revision: 1,
  goal: 'review the note',
  assignee: { id: 'expert-1', kind: 'expert' },
  dependencyNodeIds: [],
  reviewRequired: true,
  reviewerIds: ['human-1'],
  inputRefs: [],
  expertRef: { id: 'expert-1', version: 'applied-plan-1' },
  skillRefs: [],
  mcpRefs: [],
  inputNote: '',
  expectedOutput: '',
};

// @ts-expect-error expert nodes require a versioned expertRef
const expertWithoutRef: NodeHandoff = {
  nodeId: 'node-3',
  taskId: 'task-1',
  workflowVersionId: 'workflow-1',
  revision: 1,
  goal: 'review the note',
  assignee: { id: 'expert-1', kind: 'expert' },
  dependencyNodeIds: [],
  reviewRequired: true,
  reviewerIds: [],
  inputRefs: [],
  skillRefs: [],
  mcpRefs: [],
  inputNote: '',
  expectedOutput: '',
};

// @ts-expect-error agent is not an external actor
const agentActor: ActorRef = { id: 'run-1', kind: 'agent' };

// @ts-expect-error retry must name returnTo
const retryWithoutReturn: NodeTransition = { type: 'retry' };

// @ts-expect-error restart must name returnTo
const restartWithoutReturn: NodeTransition = { type: 'restart' };

const handoffIsClean: PayloadExcludesCredentials<NodeHandoff> = true;
const refIsClean: PayloadExcludesCredentials<VersionedRef> = true;
const actorIsClean: PayloadExcludesCredentials<ActorRef> = true;

// @ts-expect-error password is a credential field
const password: PayloadExcludesCredentials<{ password: string }> = true;

// @ts-expect-error nested password is a credential field
const nestedPassword: PayloadExcludesCredentials<{ auth: { password: string } }> = true;

// @ts-expect-error accessToken is a credential field
const accessToken: PayloadExcludesCredentials<{ accessToken: string }> = true;

// @ts-expect-error credential names are compared without case
const upperPassword: PayloadExcludesCredentials<{ Password: string }> = true;

// @ts-expect-error a string index signature can hide a credential
const indexed: PayloadExcludesCredentials<{ [key: string]: string }> = true;

// @ts-expect-error a credential nested in an array is still a credential
const listed: PayloadExcludesCredentials<{ items: readonly { token: string }[] }> = true;

// @ts-expect-error api_key is a credential field
const apiKey: PayloadExcludesCredentials<{ api_key: string }> = true;

// @ts-expect-error refreshToken is a credential field
const refreshToken: PayloadExcludesCredentials<{ refreshToken: string }> = true;

// @ts-expect-error privateKey is a credential field
const privateKey: PayloadExcludesCredentials<{ privateKey: string }> = true;

// @ts-expect-error cookie is a credential field
const cookie: PayloadExcludesCredentials<{ cookie: string }> = true;

void human;
void expert;
void expertWithoutRef;
void agentActor;
void retryWithoutReturn;
void restartWithoutReturn;
void handoffIsClean;
void refIsClean;
void actorIsClean;
void password;
void nestedPassword;
void accessToken;
void upperPassword;
void indexed;
void listed;
void apiKey;
void refreshToken;
void privateKey;
void cookie;
