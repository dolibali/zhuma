import { canonicalPayload } from '@zhuma/agent-core';
import type {
  FrozenExecutionRunComposition,
  ResultIntentToolDefinition,
} from './execution-run-composition.js';
import { describeNativeResultTool } from './native-work-session-result-tool.js';
import { describeNativeResultPublicationsTool } from './native-work-session-result-publications-tool.js';
import {
  NATIVE_RESULT_TOOL,
  NATIVE_RESULT_TOOL_VERSION,
} from './native-work-session-result-contract.js';
import { NATIVE_RESULT_PUBLICATIONS_TOOL_VERSION } from './native-work-session-result-publications-contract.js';
import { ExecutionRunError } from './execution-run-state.js';

/** Original exact declarations only. A new choice never changes a saved Run. */
export function hostResultTool(protocol: 1 | 2): ResultIntentToolDefinition {
  const sourceVersion =
    protocol === 1 ? NATIVE_RESULT_TOOL_VERSION : NATIVE_RESULT_PUBLICATIONS_TOOL_VERSION;
  const definition =
    protocol === 1 ? describeNativeResultTool() : describeNativeResultPublicationsTool();
  if (definition.name !== NATIVE_RESULT_TOOL || definition.sourceVersion !== sourceVersion)
    throw new ExecutionRunError('run-authority-unavailable');
  return { ...definition, name: NATIVE_RESULT_TOOL, sourceVersion };
}

export function frozenHostResultProtocol(
  snapshot: FrozenExecutionRunComposition,
): 1 | 2 | undefined {
  if (snapshot.schemaVersion !== 2 || !snapshot.payload.resultIntentTool) return undefined;
  const definition = snapshot.payload.resultIntentTool;
  const protocol = definition.sourceVersion === NATIVE_RESULT_TOOL_VERSION ? 1 : 2;
  return canonicalPayload(definition) === canonicalPayload(hostResultTool(protocol))
    ? protocol
    : undefined;
}
