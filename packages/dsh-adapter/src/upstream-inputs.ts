/**
 * Accepted upstream references for the delivery page.
 * File bytes, file names, and artifact text stay on the stored version.
 */
export interface VisibleUpstreamInput {
  readonly access: 'visible';
  readonly sourceNodeId: string;
  readonly sourceGoal?: string;
  readonly version: number;
  readonly name: string;
}

export interface RedactedUpstreamInput {
  readonly access: 'redacted';
  readonly sourceNodeId: string;
}

export type UpstreamInputView = VisibleUpstreamInput | RedactedUpstreamInput;

interface UpstreamRef {
  readonly sourceNodeId: string;
  readonly artifactVersionId: string;
}

interface UpstreamRecord {
  readonly nodeId: string;
  readonly handoff: { readonly goal?: string; readonly inputRefs?: readonly UpstreamRef[] };
  readonly acceptedArtifactVersionId?: string;
  readonly artifactVersions?: readonly { readonly id: string; readonly version: number }[];
}

function acceptedName(
  record: UpstreamRecord,
  artifactVersionId: string,
): { readonly version: number; readonly name: string } | undefined {
  if (record.acceptedArtifactVersionId !== artifactVersionId) return undefined;
  const artifact = record.artifactVersions?.find((item) => item.id === artifactVersionId);
  if (!artifact || !Number.isSafeInteger(artifact.version)) return undefined;
  const name = artifact.id.trim();
  if (name === '') return undefined;
  return { version: artifact.version, name };
}

/** One row per stored input ref. A source outside `accessible` is only an id. */
export function upstreamInputsFor(
  record: UpstreamRecord,
  accessible: readonly UpstreamRecord[],
): UpstreamInputView[] {
  const refs = record.handoff.inputRefs ?? [];
  const views: UpstreamInputView[] = [];
  for (const ref of refs) {
    const sourceNodeId = ref.sourceNodeId.trim();
    const artifactVersionId = ref.artifactVersionId.trim();
    if (sourceNodeId === '' || artifactVersionId === '') continue;
    const source = accessible.find((item) => item.nodeId === sourceNodeId);
    const accepted = source ? acceptedName(source, artifactVersionId) : undefined;
    if (!source || !accepted) {
      views.push({ access: 'redacted', sourceNodeId });
      continue;
    }
    const sourceGoal = source.handoff.goal?.trim() ?? '';
    views.push({
      access: 'visible',
      sourceNodeId,
      ...(sourceGoal === '' ? {} : { sourceGoal }),
      version: accepted.version,
      name: accepted.name,
    });
  }
  return views;
}
