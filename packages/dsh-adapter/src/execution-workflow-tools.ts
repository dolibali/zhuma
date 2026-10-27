import { z } from 'zod';
import {
  ExecutionWorkflowError,
  workflowDefaultsSchema,
  type WorkflowRunDefaults,
} from './execution-workflow-contract.js';

const nonblank = z.string().refine((value) => value.trim().length > 0);
const inputs = z.array(
  z.strictObject({
    sourceNodeId: nonblank,
    artifactVersionId: nonblank,
    contextPackId: nonblank.optional(),
  }),
);

/** A workflow reader policy permits only the fixed inputs present on this node.
 * Unknown refs are not an empty list. This neither grants access nor edits refs. */
export function effectiveWorkflowToolKind(
  policy: WorkflowRunDefaults['tools'],
  inputRefs: unknown,
): WorkflowRunDefaults['tools'] {
  const kind = workflowDefaultsSchema.shape.tools.safeParse(policy);
  const refs = inputs.safeParse(inputRefs);
  if (
    !kind.success ||
    !refs.success ||
    new Set(refs.data.map((ref) => ref.sourceNodeId)).size !== refs.data.length
  )
    throw new ExecutionWorkflowError('workflow-defaults-mismatch');
  if (kind.data === 'accepted-input-reader')
    return refs.data.length ? 'accepted-input-reader' : 'text-only';
  if (kind.data === 'text-only' && refs.data.length)
    throw new ExecutionWorkflowError('workflow-defaults-mismatch');
  return kind.data;
}
