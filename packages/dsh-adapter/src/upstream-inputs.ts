export interface VisibleUpstreamInput {
  readonly access: 'visible';
  readonly blocking: boolean;
  readonly sourceNodeId: string;
  readonly sourceGoal?: string;
  readonly version: number;
  readonly name: string;
}

export interface PendingUpstreamInput {
  readonly access: 'pending';
  readonly pending: 'none' | 'replaced';
  readonly blocking: boolean;
  readonly sourceNodeId: string;
  readonly message: string;
}

export interface HiddenUpstreamInput {
  readonly access: 'hidden';
  readonly blocking: boolean;
  readonly count: number;
  readonly message: string;
}

export type UpstreamInputView = VisibleUpstreamInput | PendingUpstreamInput | HiddenUpstreamInput;

interface UpstreamRef {
  readonly sourceNodeId: string;
  readonly artifactVersionId: string;
}

interface UpstreamRecord {
  readonly nodeId: string;
  readonly taskId: string;
  readonly planId: string;
  readonly revision: number;
  readonly handoff: { readonly goal?: string; readonly inputRefs?: readonly UpstreamRef[] };
  readonly acceptedArtifactVersionId?: string;
  readonly artifactVersions?: readonly { readonly id: string; readonly version: number }[];
}

/** Submit blocks only for the anonymous count. Pending stays a hint. */
export function isBlockingInput(input: { readonly access: UpstreamInputView['access'] }): boolean {
  return input.access === 'hidden';
}

/** Message for every blocking row. Pending is included only if it starts blocking. */
export function upstreamBlockMessage(inputs: readonly UpstreamInputView[]): string | undefined {
  const messages = inputs
    .filter(isBlockingInput)
    .flatMap((item) => (item.access === 'visible' ? [] : [item.message]));
  return messages.length === 0 ? undefined : messages.join('');
}

function hiddenUpstreamMessage(count: number): string {
  return `有 ${count} 个上游来源你没有权限查看。`;
}

function pendingMessage(kind: 'none' | 'replaced', sourceNodeId: string): string {
  return kind === 'none'
    ? `上游节点 ${sourceNodeId} 尚无已接受版本。`
    : `上游节点 ${sourceNodeId} 已有新的已接受版本，当前引用的版本已被取代。`;
}

function acceptedName(
  record: UpstreamRecord,
  artifactVersionId: string,
): { readonly version: number; readonly name: string } | undefined {
  if (record.acceptedArtifactVersionId !== artifactVersionId) return undefined;
  const artifact = record.artifactVersions?.find((item) => item.id === artifactVersionId);
  if (!artifact || !Number.isSafeInteger(artifact.version)) return undefined;
  if (artifact.id.trim() === '') return undefined;
  return { version: artifact.version, name: `第 ${artifact.version} 版` };
}

function row<T extends { readonly access: UpstreamInputView['access'] }>(
  input: T,
): T & { readonly blocking: boolean } {
  return { ...input, blocking: isBlockingInput(input) };
}

/** Visible and pending keep their order. Hidden refs collapse into one trailing count. */
export function upstreamInputsFor(
  record: UpstreamRecord,
  accessible: readonly UpstreamRecord[],
): UpstreamInputView[] {
  const views: UpstreamInputView[] = [];
  let hidden = 0;
  for (const ref of record.handoff.inputRefs ?? []) {
    const sourceNodeId = ref.sourceNodeId.trim();
    const artifactVersionId = ref.artifactVersionId.trim();
    const source =
      sourceNodeId === '' || artifactVersionId === ''
        ? undefined
        : accessible.find(
            (item) =>
              item.taskId === record.taskId &&
              item.planId === record.planId &&
              item.revision === record.revision &&
              item.nodeId === sourceNodeId,
          );
    if (!source) {
      hidden += 1;
      continue;
    }
    const acceptedId = source.acceptedArtifactVersionId?.trim() ?? '';
    const named =
      acceptedId === artifactVersionId ? acceptedName(source, artifactVersionId) : undefined;
    if (named) {
      const sourceGoal = source.handoff.goal?.trim() ?? '';
      views.push(
        row({
          access: 'visible',
          sourceNodeId,
          ...(sourceGoal === '' ? {} : { sourceGoal }),
          version: named.version,
          name: named.name,
        }),
      );
      continue;
    }
    const pending = acceptedId !== '' && acceptedId !== artifactVersionId ? 'replaced' : 'none';
    views.push(
      row({
        access: 'pending',
        pending,
        sourceNodeId,
        message: pendingMessage(pending, sourceNodeId),
      }),
    );
  }
  if (hidden > 0) {
    views.push(
      row({
        access: 'hidden',
        count: hidden,
        message: hiddenUpstreamMessage(hidden),
      }),
    );
  }
  return views;
}
