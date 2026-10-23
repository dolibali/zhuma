import {
  WorkbenchSchema,
  PlanProposalSchema,
  ImportPackagePreviewSchema,
  ResourceFilesReplySchema,
  type ImportPackagePreview,
  type PackageFile,
  type PackageUpload,
  WorkbenchError,
  type Workbench,
  type WorkbenchCommand,
  type PlanProposal,
} from '@zhuma/agent-core';
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client';

export interface WorkbenchApi {
  snapshot(signal?: AbortSignal): Promise<{ state: Workbench; model: string }>;
  save(revision: number, command: WorkbenchCommand, requestId: string): Promise<Workbench>;
  previewImport(source: PackageUpload, signal: AbortSignal): Promise<ImportPackagePreview>;
  resourceFiles(
    kind: 'asset' | 'expert',
    id: string,
    signal: AbortSignal,
  ): Promise<{ versionId: string; files: PackageFile[] }>;
  plan(
    taskId: string,
    revision: number,
    instruction: string,
    signal: AbortSignal,
    baseProposalId?: string,
  ): Promise<PlanProposal>;
}
export function createWorkbenchApi(rpc: ClientConnectionRpc): WorkbenchApi {
  async function call(endpoint: string, payload: object, signal?: AbortSignal): Promise<unknown> {
    const response = await rpc.call('/api', `zhuma/${endpoint}`, payload, signal);
    if (!response.ok) throw new WorkbenchError(response.error.code, response.error.message);
    return response.value;
  }
  return {
    async snapshot(signal) {
      const raw = await call('snapshot', {}, signal);
      if (
        typeof raw !== 'object' ||
        !raw ||
        !('state' in raw) ||
        !('model' in raw) ||
        typeof raw.model !== 'string'
      )
        throw new Error('工作台数据格式不正确。');
      return { state: WorkbenchSchema.parse(raw.state), model: raw.model };
    },
    async save(expectedRevision, command, requestId) {
      return WorkbenchSchema.parse(await call('command', { expectedRevision, command, requestId }));
    },
    async previewImport(source, signal) {
      return ImportPackagePreviewSchema.parse(await call('preview-import', source, signal));
    },
    async resourceFiles(kind, id, signal) {
      return ResourceFilesReplySchema.parse(await call('resource-files', { kind, id }, signal));
    },
    async plan(taskId, expectedRevision, instruction, signal, baseProposalId) {
      return PlanProposalSchema.parse(
        await call(
          'plan',
          { requestId: crypto.randomUUID(), taskId, expectedRevision, instruction, baseProposalId },
          signal,
        ),
      );
    },
  };
}
