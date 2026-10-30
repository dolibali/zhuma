import { createHash } from 'node:crypto';
import {
  applyWorkbenchCommand,
  CommandRequestSchema,
  PlanRequestSchema,
  WorkbenchError,
  planningPrompt,
  parsePlanningResult,
  validateLocalPlanningChange,
  previewResourcePackage,
  parseWorkflowTemplate,
  WorkbenchSchema,
  StoredAssetPackageSchema,
  type StoredAssetPackage,
  type Workbench,
  type PlanProposal,
} from '@zhuma/agent-core';
import type {
  MemberWorkbenchIntent,
  MemberWorkbenchOperations,
} from './member-workbench-operation.js';

export interface WorkbenchStorage {
  read(): Workbench;
  write(state: Workbench): Promise<void>;
}
export interface PlanningAudit {
  id: string;
  fingerprint: string;
  taskId: string;
  baseRevision: number;
  model: string;
  system: string;
  attempts: { input: string; output: string }[];
  status: 'started' | 'completed' | 'failed';
  proposal?: PlanProposal | undefined;
}
export interface PlanningAuditStorage {
  get(id: string): PlanningAudit | undefined;
  put(audit: PlanningAudit): Promise<void>;
}
export interface PlanningModel {
  readonly name: string;
  generate(system: string, input: string, signal: AbortSignal): Promise<string>;
}
export interface AssetPackageStorage {
  get(versionId: string): StoredAssetPackage | undefined;
  put(value: StoredAssetPackage): Promise<void>;
}
type MemberAssetRecord = NonNullable<Workbench['memberAssets']>[number];
const fingerprint = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** A provider ignoring cancellation cannot retain the service's planning slot or publish late. */
function generateAbortably(
  model: PlanningModel,
  system: string,
  input: string,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return model.generate(system, input, signal);
      })
      .then(
        (value) => {
          signal.removeEventListener('abort', abort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', abort);
          reject(error);
        },
      );
  });
}

/** Host owner of serialized durable commands. Browser state is never authoritative. */
export class WorkbenchService {
  private writes: Promise<unknown> = Promise.resolve();
  private planning = false;
  constructor(
    private readonly storage: WorkbenchStorage,
    private readonly audits: PlanningAuditStorage,
    private readonly packages?: AssetPackageStorage,
  ) {}
  snapshot(): Workbench {
    return structuredClone(this.storage.read());
  }

  /** Host-only asset fact access; public member snapshots strip this leaf. */
  memberAssetRecords(): readonly MemberAssetRecord[] {
    return structuredClone(this.storage.read().memberAssets ?? []);
  }

  /** Small byte-boundary guard without cloning whole definitions on every chunk. */
  memberAssetVersion(spaceId: string, assetId: string): number | undefined {
    const rows = (this.storage.read().memberAssets ?? []).filter(
      (item) => item.spaceId === spaceId && item.assetId === assetId,
    );
    if (rows.length > 1) throw new WorkbenchError('asset-unavailable', '资产事实暂不可用。');
    return rows[0]?.version;
  }

  /** Private immutable bytes are still the original package table, not a new store. */
  memberAssetPackage(versionId: string): StoredAssetPackage | undefined {
    const raw = this.packages?.get(versionId);
    if (!raw) return undefined;
    const record = StoredAssetPackageSchema.parse(raw);
    if (record.digest !== fingerprint(record.files))
      throw new WorkbenchError('asset-unavailable', '资产来源暂不可用。');
    return structuredClone(record);
  }

  async putMemberAssetPackage(record: StoredAssetPackage): Promise<void> {
    if (!this.packages) throw new WorkbenchError('asset-unavailable', '资产来源尚未接入。');
    const next = StoredAssetPackageSchema.parse(record);
    if (next.digest !== fingerprint(next.files))
      throw new WorkbenchError('asset-invalid', '资产来源校验失败。');
    const old = this.memberAssetPackage(next.versionId);
    if (old) {
      if (fingerprint(old) !== fingerprint(next))
        throw new WorkbenchError('asset-conflict', '资产来源版本已存在。');
      return;
    }
    await this.packages.put(next);
  }

  /** The original writer queue owns the only mutation. Asset callers cannot
   * replace tasks, plans, profiles or unrelated Workbench facts. */
  memberAssetCommand<T>(
    signal: AbortSignal,
    authorize: () => void | Promise<void>,
    apply: (records: readonly MemberAssetRecord[]) => Promise<{
      readonly records?: readonly MemberAssetRecord[];
      readonly value: T;
    }>,
  ): Promise<T> {
    const operation = this.writes.then(async () => {
      signal.throwIfAborted();
      await authorize();
      const state = this.snapshot();
      const result = await apply(state.memberAssets ?? []);
      signal.throwIfAborted();
      await authorize();
      signal.throwIfAborted();
      if (result.records) {
        const next = WorkbenchSchema.parse({
          ...state,
          revision: state.revision + 1,
          memberAssets: result.records,
        });
        signal.throwIfAborted();
        await this.storage.write(next);
      }
      return structuredClone(result.value);
    });
    this.writes = operation.catch(() => undefined);
    return operation;
  }

  /** Host-only member entry. Shares the legacy writer queue and the same durable fact. */
  memberCommand(
    request: { receiptId: string; fingerprint: string; expectedRevision: number },
    signal: AbortSignal,
    authorize: () => Promise<void>,
    apply: (state: Workbench) => Promise<Workbench>,
    recovery: { journal: MemberWorkbenchOperations; intent: MemberWorkbenchIntent },
  ): Promise<Workbench> {
    const operation = this.writes.then(async () => {
      signal.throwIfAborted();
      await authorize();
      const state = this.snapshot();
      const intent = recovery.journal.inspect(recovery.intent);
      const resultPresent = () => {
        const object = recovery.intent;
        if (object.commandType === 'save-template') {
          const asset = state.assets.find((item) => item.id === object.objectId);
          return (
            !!asset &&
            asset.kind === 'template' &&
            asset.memberTemplate?.spaceId === object.spaceId &&
            asset.memberTemplate.ownerId === object.actorId &&
            asset.memberTemplate.sourceWorkbenchRevision === object.expectedRevision &&
            object.templateResultFingerprint === fingerprint(asset)
          );
        }
        if (object.commandType === 'create-project' || object.commandType === 'update-project')
          return state.projects.some((p) => p.id === object.objectId);
        if (!state.tasks.some((t) => t.id === object.objectId)) return false;
        return (
          object.commandType !== 'confirm-task' ||
          state.appliedPlans.some(
            (p) =>
              p.taskId === object.objectId && p.sourceWorkbenchRevision === object.expectedRevision,
          )
        );
      };
      if (intent?.state === 'completed') {
        if (state.revision < intent.resultRevision || !resultPresent())
          throw new WorkbenchError('operation-unresolved', '操作结果需要核实，不能重复执行。');
        await recovery.journal.complete(recovery.intent, intent.resultRevision);
        return state;
      }
      const prior = state.receipts.find((r) => r.id === request.receiptId);
      if (prior) {
        if (prior.fingerprint !== request.fingerprint)
          throw new WorkbenchError('request-reused', '请求标识已用于另一个操作。');
        if (!resultPresent())
          throw new WorkbenchError('operation-unresolved', '操作结果需要核实，不能重复执行。');
        await recovery.journal.complete(recovery.intent, prior.revision);
        return state;
      }
      if (intent && state.revision !== request.expectedRevision)
        throw new WorkbenchError('operation-unresolved', '操作依据已变化，需要核实原操作结果。');
      if (state.revision !== request.expectedRevision)
        throw new WorkbenchError('conflict', '内容已变化，请刷新后再提交。');
      const next = await apply(state);
      if (next.revision !== state.revision + 1)
        throw new WorkbenchError('validation', '成员命令必须提交一个工作台版本。');
      next.receipts = [
        ...state.receipts,
        { id: request.receiptId, fingerprint: request.fingerprint, revision: next.revision },
      ].slice(-200);
      const validated = WorkbenchSchema.parse(next);
      // Recheck after async directory work and immediately before durability.
      signal.throwIfAborted();
      await authorize();
      signal.throwIfAborted();
      await this.storage.write(validated);
      await recovery.journal.complete(recovery.intent, validated.revision);
      return structuredClone(validated);
    });
    this.writes = operation.catch(() => undefined);
    return operation;
  }

  command(raw: unknown, signal: AbortSignal): Promise<Workbench> {
    const request = CommandRequestSchema.parse(raw);
    const operation = this.writes.then(async () => {
      signal.throwIfAborted();
      const state = this.storage.read();
      // Absent owner and explicit null are the same legacy draft, including old idempotent retries.
      let fingerprintInput: unknown = request.command;
      if (request.command.type === 'save-task' && request.command.task.ownerId === null) {
        const { ownerId: _owner, ...task } = request.command.task;
        fingerprintInput = { ...request.command, task };
      }
      const hash = fingerprint(fingerprintInput);
      const receipt = state.receipts.find((r) => r.id === request.requestId);
      if (receipt) {
        if (receipt.fingerprint !== hash)
          throw new WorkbenchError('request-reused', '请求标识已用于另一个操作。');
        return this.snapshot();
      }
      if (state.revision !== request.expectedRevision)
        throw new WorkbenchError('conflict', '内容已被其他窗口修改。请先刷新，再应用你的更改。');
      const next = applyWorkbenchCommand(state, request.command);
      if (request.command.type === 'import-package') {
        if (!this.packages) throw new WorkbenchError('asset-storage', '资产包存储尚未接入。');
        const files = previewResourcePackage(
          request.command.input.files,
          parseWorkflowTemplate,
        ).files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
        const record = StoredAssetPackageSchema.parse({
          versionId: request.command.input.versionId,
          files,
          digest: fingerprint(files),
        });
        const previous = this.packages.get(record.versionId);
        if (previous && previous.digest !== record.digest)
          throw new WorkbenchError('asset-version', '来源包版本已存在，不能替换已固定的文件。');
        // Persist immutable files first. A failed catalog write leaves no visible resource;
        // the same command can reuse these bytes and publish once on retry.
        if (!previous) await this.packages.put(record);
      }
      next.receipts = [
        ...state.receipts,
        { id: request.requestId, fingerprint: hash, revision: next.revision },
      ].slice(-200);
      // Once durability starts cancellation cannot roll back a successful write; retry with the same ID.
      await this.storage.write(next);
      return structuredClone(next);
    });
    this.writes = operation.catch(() => undefined);
    return operation;
  }

  resourceFiles(
    kind: 'asset' | 'expert',
    id: string,
  ): { versionId: string; files: StoredAssetPackage['files'] } {
    const state = this.storage.read();
    const resource =
      kind === 'asset'
        ? state.assets.find((a) => a.id === id)
        : state.participants.find((p) => p.id === id && p.kind === 'expert');
    if (!resource?.origin) throw new WorkbenchError('not-found', '当前定义没有来源包。');
    const stored = this.packages?.get(resource.origin.versionId);
    if (!stored) throw new WorkbenchError('asset-unavailable', '来源文件暂不可用，请重新导入。');
    const allowed = new Set(resource.origin.filePaths);
    const files = stored.files.filter((f) => allowed.has(f.path));
    if (files.length !== allowed.size)
      throw new WorkbenchError('asset-unavailable', '来源文件不完整，请重新导入。');
    return structuredClone({ versionId: stored.versionId, files });
  }

  async plan(
    raw: unknown,
    model: PlanningModel,
    signal: AbortSignal,
    member?: { scopeKey: string; read: () => Promise<Workbench> },
  ): Promise<PlanProposal> {
    const request = PlanRequestSchema.parse(raw);
    signal.throwIfAborted();
    const state = member ? await member.read() : this.snapshot();
    if (member && request.expectedRevision !== state.revision)
      throw new WorkbenchError('conflict', '规划依据已经变化，请刷新后再试。');
    const contextFingerprint = (value: Workbench) =>
      fingerprint([value.projects, value.tasks, value.participants, value.assets]);
    const authorizedContext = member ? contextFingerprint(state) : undefined;
    const reauthorize = async () => {
      if (!member) return;
      const current = await member.read();
      if (current.revision !== state.revision)
        throw new WorkbenchError('conflict', '规划依据已经变化，请刷新后再试。');
      if (contextFingerprint(current) !== authorizedContext)
        throw new WorkbenchError('context-changed', '授权资源已变化，请刷新后重新规划。');
    };
    const auditKey = (id: string) => (member ? `member-${fingerprint([member.scopeKey, id])}` : id);
    const previous = this.audits.get(auditKey(request.requestId));
    const hash = member
      ? `${fingerprint([member.scopeKey, request])}:${authorizedContext}`
      : fingerprint(request);
    if (previous) {
      if (previous.fingerprint !== hash) {
        if (member && previous.fingerprint.split(':')[0] === hash.split(':')[0])
          throw new WorkbenchError('context-changed', '授权资源已变化，请刷新后重新规划。');
        throw new WorkbenchError('request-reused', '请求标识已用于另一次规划。');
      }
      if (previous.proposal) {
        await reauthorize();
        return structuredClone(previous.proposal);
      }
      throw new WorkbenchError('plan-interrupted', '这次规划未完成，请重新发起规划。');
    }
    if (this.planning)
      throw new WorkbenchError('planning-busy', '已有规划正在生成，请等待或取消后重试。');
    if (request.expectedRevision !== state.revision)
      throw new WorkbenchError('conflict', '规划依据已经变化，请刷新后再试。');
    const task = state.tasks.find((t) => t.id === request.taskId);
    if (!task) throw new WorkbenchError('not-found', '任务不存在。');
    if (task.status !== 'draft')
      throw new WorkbenchError('not-draft', '请先将工作流切回草稿，再重新规划。');
    let baseProposal: PlanProposal | undefined;
    if (request.baseProposalId) {
      const base = this.audits.get(auditKey(request.baseProposalId));
      if (!base || base.status !== 'completed' || !base.proposal)
        throw new WorkbenchError('proposal-unavailable', '原草案已不可用，请放弃草案后重新生成。');
      if (base.taskId !== task.id || base.proposal.taskId !== task.id)
        throw new WorkbenchError('proposal-mismatch', '原草案不属于当前任务，不能用于调整。');
      if (base.baseRevision !== state.revision || base.proposal.baseRevision !== state.revision)
        throw new WorkbenchError(
          'conflict',
          '原草案的规划依据已经变化，请读取最新版本后重新生成。',
        );
      if (member && base.fingerprint.split(':')[1] !== authorizedContext)
        throw new WorkbenchError('context-changed', '原草案的授权资源已变化，请重新规划。');
      baseProposal = base.proposal;
    }
    const prompt = planningPrompt(
      state,
      task,
      request.instruction,
      baseProposal,
      request.adjustment,
    );
    const audit: PlanningAudit = {
      id: auditKey(request.requestId),
      fingerprint: hash,
      taskId: task.id,
      baseRevision: state.revision,
      model: model.name,
      system: prompt.system,
      attempts: [],
      status: 'started',
    };
    this.planning = true;
    try {
      let input = prompt.input;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        signal.throwIfAborted();
        await reauthorize();
        audit.attempts.push({ input, output: '' });
        await this.audits.put(structuredClone(audit));
        await reauthorize();
        const output = member
          ? await generateAbortably(model, prompt.system, input, signal)
          : await model.generate(prompt.system, input, signal);
        signal.throwIfAborted();
        await reauthorize();
        audit.attempts[attempt]!.output = output;
        await this.audits.put(structuredClone(audit));
        try {
          const result = parsePlanningResult(output, state, task, prompt.context);
          if (request.adjustment)
            validateLocalPlanningChange(
              prompt.context.currentWorkflows,
              result.workflows,
              request.adjustment,
            );
          const proposal: PlanProposal = {
            id: request.requestId,
            taskId: task.id,
            baseRevision: state.revision,
            model: model.name,
            result,
          };
          audit.status = 'completed';
          audit.proposal = proposal;
          await this.audits.put(structuredClone(audit));
          await reauthorize();
          return proposal;
        } catch (error) {
          if (!(error instanceof WorkbenchError) || error.code !== 'invalid-plan' || attempt === 1)
            throw error;
          input = JSON.stringify({
            original: prompt.input,
            rejectedOutput: output,
            validationErrors: error.message,
            instruction: '修复上述校验问题，只返回完整 JSON 对象。',
          });
        }
      }
      throw new WorkbenchError('invalid-plan', '规划没有产生有效草案。');
    } catch (error) {
      audit.status = 'failed';
      if (member) delete audit.proposal;
      await this.audits.put(structuredClone(audit));
      throw error;
    } finally {
      this.planning = false;
    }
  }
}
