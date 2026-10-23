import type {
  ActorRef,
  ContextInputRef,
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

// @ts-expect-error an input ref must name both the source node and the artifact version
const inputRefMissingArtifact: ContextInputRef = { sourceNodeId: 'node-0' };

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

// @ts-expect-error refresh_token is a credential field
const refreshTokenSnake: PayloadExcludesCredentials<{ refresh_token: string }> = true;

// @ts-expect-error private_key is a credential field
const privateKeySnake: PayloadExcludesCredentials<{ private_key: string }> = true;

// @ts-expect-error sessionToken is a credential field
const sessionToken: PayloadExcludesCredentials<{ sessionToken: string }> = true;

// @ts-expect-error bearer is a credential field
const bearer: PayloadExcludesCredentials<{ bearer: string }> = true;

// @ts-expect-error access_token is a credential field
const accessTokenSnake: PayloadExcludesCredentials<{ access_token: string }> = true;

// @ts-expect-error access-token is a credential field
const accessTokenHyphen: PayloadExcludesCredentials<{ 'access-token': string }> = true;

// @ts-expect-error session_token is a credential field
const sessionTokenSnake: PayloadExcludesCredentials<{ session_token: string }> = true;

// @ts-expect-error session-token is a credential field
const sessionTokenHyphen: PayloadExcludesCredentials<{ 'session-token': string }> = true;

// @ts-expect-error client_secret is a credential field
const clientSecret: PayloadExcludesCredentials<{ client_secret: string }> = true;

// @ts-expect-error client-secret is a credential field
const clientSecretHyphen: PayloadExcludesCredentials<{ 'client-secret': string }> = true;

// @ts-expect-error id_token is a credential field
const idTokenSnake: PayloadExcludesCredentials<{ id_token: string }> = true;

// @ts-expect-error idToken is a credential field
const idToken: PayloadExcludesCredentials<{ idToken: string }> = true;

// @ts-expect-error id-token is a credential field
const idTokenHyphen: PayloadExcludesCredentials<{ 'id-token': string }> = true;

// @ts-expect-error bearerToken is a credential field
const bearerToken: PayloadExcludesCredentials<{ bearerToken: string }> = true;

// @ts-expect-error bearer-token is a credential field
const bearerTokenHyphen: PayloadExcludesCredentials<{ 'bearer-token': string }> = true;

// @ts-expect-error sessionId is a credential field
const sessionId: PayloadExcludesCredentials<{ sessionId: string }> = true;

// @ts-expect-error session-id is a credential field
const sessionIdHyphen: PayloadExcludesCredentials<{ 'session-id': string }> = true;

// @ts-expect-error secretKey is a credential field
const secretKey: PayloadExcludesCredentials<{ secretKey: string }> = true;

// @ts-expect-error secret-key is a credential field
const secretKeyHyphen: PayloadExcludesCredentials<{ 'secret-key': string }> = true;

// @ts-expect-error passwd is a credential field
const passwd: PayloadExcludesCredentials<{ passwd: string }> = true;

// @ts-expect-error auth is a credential field
const auth: PayloadExcludesCredentials<{ auth: string }> = true;

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
void refreshTokenSnake;
void privateKeySnake;
void sessionToken;
void bearer;
void accessTokenSnake;
void accessTokenHyphen;
void sessionTokenSnake;
void sessionTokenHyphen;
void clientSecret;
void clientSecretHyphen;
void idTokenSnake;
void idToken;
void idTokenHyphen;
void bearerToken;
void bearerTokenHyphen;
void sessionId;
void sessionIdHyphen;
void secretKey;
void secretKeyHyphen;
void passwd;
void auth;
