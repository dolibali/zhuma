/** Pure confirmed-plan/catalog inputs only. No connection, filesystem or publication authority. */
import { compositionFacts, reader } from './execution-run-composition-fixture.mjs';
import { describeNativeAcceptedFileTool } from '../dist/native-work-session-files-tool.js';
import { describeNativeResultTool } from '../dist/native-work-session-result-tool.js';
import {
  EXECUTION_RESOURCE_SOURCE_VERSION,
  executionResourceDigest,
} from '../dist/execution-run-resource-snapshot.js';

export function combinedPublisherFacts({ maximal = false, publisher } = {}) {
  const input = {
    ...compositionFacts({ upstream: true }),
    acceptedFileReader: describeNativeAcceptedFileTool(),
    resultIntentTool: describeNativeResultTool(),
    ...(publisher ? { outputFilePublisherTool: publisher } : {}),
  };
  input.tools = {
    kind: 'local-tools',
    definitions: ['read', 'write', 'edit'].map((name) => ({ ...reader.definition, name })),
    shell: {
      ...reader.definition,
      name: 'bash',
      budget: { defaultTimeoutMs: 1000, maxTimeoutMs: 5000, maxAttempts: 2 },
    },
    acceptedInputReader: reader.definition,
  };
  const plan = input.workbench.appliedPlans[0];
  const step = plan.task.workflows[0].nodes.find((item) => item.id === input.node.nodeId);
  const skill = {
    id: 'method',
    name: 'Method',
    kind: 'skill',
    description: 'Contract method',
    content: 'METHOD_BODY',
    available: true,
  };
  const servers = Array.from({ length: maximal ? 4 : 1 }, (_, i) => ({
    id: `docs-${i}`,
    name: `Docs ${i}`,
    kind: 'mcp',
    description: 'Contract metadata',
    content: 'NOT_EXECUTABLE_CONFIGURATION',
    available: true,
  }));
  plan.assets = [skill, ...servers];
  step.skillIds = [skill.id];
  step.mcpIds = servers.map((item) => item.id);
  input.node.handoff.skillRefs = [{ id: skill.id, version: plan.id }];
  input.node.handoff.mcpRefs = servers.map((item) => ({ id: item.id, version: plan.id }));
  input.resourceCatalog = {
    sourceVersion: EXECUTION_RESOURCE_SOURCE_VERSION,
    mcp: servers.map((asset, i) => ({
      ref: { id: asset.id, version: plan.id },
      definitionDigest: executionResourceDigest(asset),
      connectionRef: { id: `connection-${i}`, version: 'fixed-1' },
      serverName: `docs${i}`,
      tools: Array.from({ length: maximal ? 8 : 1 }, (_, j) => ({
        name: `mcp__docs${i}__read${j}`,
        description: 'Contract',
        parameters: { type: 'object' },
        outputSchema: { type: 'object' },
      })),
    })),
  };
  return input;
}
