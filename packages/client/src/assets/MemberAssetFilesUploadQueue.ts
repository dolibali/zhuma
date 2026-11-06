import {
  MEMBER_ASSET_LIMITS,
  type MemberAssetCommand,
  type MemberAssetFileDeclare,
  type MemberAssetFileReserve,
} from '@zhuma/agent-core';
import { describeMemberAssetFile, MemberAssetClientError, type MemberAssetApi } from './api.js';

export type MemberAssetFilesUploadPhase =
  | 'queued'
  | 'hashing'
  | 'creating'
  | 'uploading'
  | 'checking'
  | 'complete'
  | 'failed'
  | 'unknown'
  | 'cancelling'
  | 'cancel-unknown'
  | 'cancelled'
  | 'stopped';
export interface MemberAssetFilesUploadRow {
  readonly id: string;
  readonly name: string;
  readonly byteSize: number;
  readonly phase: MemberAssetFilesUploadPhase;
  readonly error: string;
  readonly hasDraft: boolean;
}
export interface MemberAssetFilesUploadSnapshot {
  readonly rows: readonly MemberAssetFilesUploadRow[];
  readonly running: boolean;
  readonly completed: number;
  readonly dirty: boolean;
}
type Create = Extract<MemberAssetCommand, { operation: 'create-draft' }>;
type Cancel = Extract<MemberAssetCommand, { operation: 'cancel-upload' }>;
type Row = {
  id: string;
  file: File;
  phase: MemberAssetFilesUploadPhase;
  error: string;
  create: Create;
  createdVersion?: number;
  createAttempted: boolean;
  declare?: MemberAssetFileDeclare;
  upload?: MemberAssetFileReserve;
  uploadAttempted: boolean;
  cancel?: Cancel;
  cancelKey: string;
  cancelAcknowledged: boolean;
  stop: boolean;
  uploadAcknowledged: boolean;
  controller?: AbortController;
};
const errorText = (error: unknown) =>
  error instanceof MemberAssetClientError ? error.message : '处理尚未完成，请核对后重试原请求。';
const unknown = (error: unknown) =>
  !(error instanceof MemberAssetClientError) || error.outcome === 'unknown';
const sameFile = (a: MemberAssetFileDeclare, b: MemberAssetFileDeclare) =>
  a.name === b.name &&
  a.mediaType === b.mediaType &&
  a.byteSize === b.byteSize &&
  a.sha256 === b.sha256;

/** In-memory intent/transport queue only. Every draft, byte and cancellation
 * fact belongs to the original member services. No publication or persistence. */
export class MemberAssetFilesUploadQueue {
  private rows: Row[] = [];
  private running = false;
  private paused = false;
  private closed = false;
  private controllers = new Set<AbortController>();
  private listeners = new Set<() => void>();
  private snapshot: MemberAssetFilesUploadSnapshot = {
    rows: [],
    running: false,
    completed: 0,
    dirty: false,
  };
  constructor(
    private readonly options: {
      api: Pick<MemberAssetApi, 'command' | 'read' | 'upload'>;
      spaceId: string;
      isCurrent(): boolean;
      onChanged?(): void;
    },
  ) {}
  getSnapshot = () => this.snapshot;
  isCurrent = () => !this.closed && this.options.isCurrent();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private live(): void {
    if (this.closed || !this.options.isCurrent()) {
      this.dispose();
      throw new DOMException('Upload view changed', 'AbortError');
    }
  }
  private changed(): void {
    this.live();
    this.snapshot = {
      rows: this.rows.map((row) => ({
        id: row.id,
        name: row.file.name,
        byteSize: row.file.size,
        phase: row.phase,
        error: row.error,
        hasDraft: row.createdVersion !== undefined,
      })),
      running: this.running,
      completed: this.rows.filter((row) => row.phase === 'complete').length,
      dirty:
        this.running ||
        this.rows.some((row) => !['complete', 'cancelled', 'stopped'].includes(row.phase)),
    };
    for (const listener of this.listeners) listener();
  }
  private notify(): void {
    this.live();
    try {
      this.options.onChanged?.();
    } catch {}
  }
  private attempt() {
    this.live();
    const controller = new AbortController();
    this.controllers.add(controller);
    return {
      controller,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(125_000)]),
    };
  }
  add(files: readonly File[]): void {
    this.live();
    if (this.running) return;
    if (!files.length || this.rows.length + files.length > MEMBER_ASSET_LIMITS.runFiles)
      throw Error(`一次最多选择 ${MEMBER_ASSET_LIMITS.runFiles} 个文件。`);
    let total = this.rows.reduce((sum, row) => sum + row.file.size, 0);
    for (const file of files) {
      if (!file.name.trim() || file.webkitRelativePath || file.size > MEMBER_ASSET_LIMITS.fileBytes)
        throw Error('请选择普通文件，单个文件最多 20 MiB。');
      total += file.size;
      if (!Number.isSafeInteger(total) || total > MEMBER_ASSET_LIMITS.fileBytes)
        throw Error('本批文件总量最多 20 MiB。');
    }
    for (const file of files) {
      const id = crypto.randomUUID();
      this.rows.push({
        id,
        file,
        phase: 'queued',
        error: '',
        createAttempted: false,
        uploadAttempted: false,
        uploadAcknowledged: false,
        cancelKey: crypto.randomUUID(),
        cancelAcknowledged: false,
        stop: false,
        create: {
          operation: 'create-draft',
          spaceId: this.options.spaceId,
          assetId: id,
          expectedVersion: 0,
          idempotencyKey: crypto.randomUUID(),
          definition: { kind: 'file', name: file.name.slice(0, 160), description: '' },
          dependencies: [],
        },
      });
    }
    this.changed();
  }
  remove(id: string): void {
    this.live();
    if (this.running) return;
    const row = this.rows.find((row) => row.id === id);
    if (!row || row.createAttempted || !['queued', 'failed', 'stopped'].includes(row.phase)) return;
    this.rows = this.rows.filter((item) => item !== row);
    this.changed();
  }
  async start(): Promise<void> {
    this.live();
    if (
      this.running ||
      this.rows.some((row) => ['unknown', 'cancel-unknown', 'cancelling'].includes(row.phase))
    )
      return;
    this.running = true;
    this.paused = false;
    this.changed();
    try {
      for (;;) {
        this.live();
        if (this.paused) break;
        const row = this.rows.find((row) => row.phase === 'queued');
        if (!row) break;
        await this.process(row);
        this.live();
        if (['unknown', 'cancel-unknown', 'cancelling'].includes(row.phase)) break;
      }
    } catch {
      // Lifetime retirement stops the queue; never starts the next file.
    } finally {
      if (!this.closed && this.options.isCurrent()) {
        this.running = false;
        this.changed();
      }
    }
  }
  async retry(id: string): Promise<void> {
    this.live();
    if (this.running) return;
    const row = this.rows.find((row) => row.id === id);
    if (!row || !['failed', 'unknown', 'cancel-unknown'].includes(row.phase)) return;
    if (row.stop && row.uploadAttempted) return this.cancel(id);
    this.running = true;
    this.changed();
    try {
      await this.process(row);
    } catch {
    } finally {
      if (!this.closed && this.options.isCurrent()) {
        this.running = false;
        this.changed();
      }
    }
  }
  private async process(row: Row): Promise<void> {
    const { controller, signal } = this.attempt();
    row.controller = controller;
    row.error = '';
    try {
      if (!row.declare && !row.stop) {
        row.phase = 'hashing';
        this.changed();
        row.declare = await describeMemberAssetFile(row.file, signal);
        this.live();
        signal.throwIfAborted();
      }
      if (row.createdVersion === undefined) {
        if (row.stop && !row.createAttempted) {
          row.phase = 'stopped';
          this.changed();
          return;
        }
        row.phase = 'creating';
        this.changed();
        signal.throwIfAborted();
        row.createAttempted = true;
        const receipt = await this.options.api.command(row.create, signal);
        this.live();
        // A replay's current asset may have advanced. Never overwrite that newer
        // draft using an inherited current version; keep the original receipt.
        row.createdVersion = receipt.resultVersion;
        this.notify();
      }
      if (row.stop) {
        row.phase = 'stopped';
        this.changed();
        return;
      }
      signal.throwIfAborted();
      row.upload ??= {
        spaceId: this.options.spaceId,
        assetId: row.id,
        expectedVersion: row.createdVersion,
        idempotencyKey: crypto.randomUUID(),
        declare: row.declare!,
      };
      row.phase = 'uploading';
      this.changed();
      row.uploadAttempted = true;
      await this.options.api.upload(row.upload, row.file, signal);
      this.live();
      if (row.stop) return;
      row.uploadAcknowledged = true;
      this.notify();
      row.phase = 'checking';
      this.changed();
      const detail = await this.options.api.read(
        { spaceId: this.options.spaceId, assetId: row.id, draft: true },
        signal,
      );
      this.live();
      if (row.stop) return;
      if (!detail.file || !sameFile(detail.file, row.declare!))
        throw new MemberAssetClientError('invalid-response', 'unknown');
      row.phase = 'complete';
      this.notify();
      this.changed();
    } catch (error) {
      this.live();
      if (row.stop && row.uploadAttempted) return; // cancellation owns its result
      row.phase =
        row.stop && !row.createAttempted
          ? 'stopped'
          : row.uploadAcknowledged || unknown(error)
            ? 'unknown'
            : 'failed';
      row.error = row.stop
        ? row.createAttempted
          ? '已停止本地队列；草稿结果待核对，请重试原创建请求。'
          : ''
        : row.uploadAcknowledged
          ? '文件上传已收到回执，草稿读取待核对。请重试原请求。'
          : errorText(error);
      this.changed();
    } finally {
      this.controllers.delete(controller);
      if (row.controller === controller) delete row.controller;
    }
  }
  async cancel(id: string): Promise<void> {
    this.live();
    const row = this.rows.find((row) => row.id === id);
    if (!row || ['complete', 'cancelled', 'stopped', 'cancelling'].includes(row.phase)) return;
    this.paused = true;
    row.stop = true;
    row.controller?.abort();
    if (!row.uploadAttempted) {
      row.phase = row.createAttempted && row.createdVersion === undefined ? 'unknown' : 'stopped';
      row.error =
        row.phase === 'unknown' ? '已停止本地队列；草稿结果待核对，请重试原创建请求。' : '';
      this.changed();
      return;
    }
    const { controller, signal } = this.attempt();
    row.phase = 'cancelling';
    row.error = '';
    this.changed();
    try {
      if (!row.cancelAcknowledged) {
        if (!row.cancel) {
          const detail = await this.options.api.read(
            { spaceId: this.options.spaceId, assetId: row.id, draft: true },
            signal,
          );
          this.live();
          signal.throwIfAborted();
          // +2 is ambiguous: an old reservation may have drained without a
          // commit and a different upload may now be pending. Only matching
          // authoritative file metadata proves completion; it needs no cancel.
          if (
            detail.asset.version === row.upload!.expectedVersion + 2 &&
            detail.file &&
            sameFile(detail.file, row.declare!)
          ) {
            row.phase = 'complete';
            row.error = '文件在取消前已上传；草稿保留，尚未发布。';
            this.notify();
            this.changed();
            return;
          }
          // Only the original reservation's exact version may be fenced.
          // The command still verifies its original upload key and CAS.
          if (detail.asset.version !== row.upload!.expectedVersion + 1)
            throw new MemberAssetClientError('asset-conflict');
          row.cancel = {
            operation: 'cancel-upload',
            spaceId: this.options.spaceId,
            assetId: row.id,
            expectedVersion: detail.asset.version,
            idempotencyKey: row.cancelKey,
            uploadKey: row.upload!.idempotencyKey,
          };
        }
        await this.options.api.command(row.cancel, signal);
        this.live();
        row.cancelAcknowledged = true;
        this.notify();
      }
      this.live();
      signal.throwIfAborted();
      const detail = await this.options.api.read(
        { spaceId: this.options.spaceId, assetId: row.id, draft: true },
        signal,
      );
      this.live();
      signal.throwIfAborted();
      if (detail.file && !sameFile(detail.file, row.declare!))
        throw new MemberAssetClientError('invalid-response', 'unknown');
      row.phase = detail.file ? 'complete' : 'cancelled';
      row.error = detail.file ? '文件在取消前已上传；草稿保留，尚未发布。' : '';
      this.changed();
    } catch (error) {
      this.live();
      if (
        !row.cancelAcknowledged &&
        error instanceof MemberAssetClientError &&
        error.outcome === 'rejected' &&
        ['asset-conflict', 'asset-not-found'].includes(error.code)
      )
        delete row.cancel;
      row.phase = 'cancel-unknown';
      row.error = '取消结果待核对。请重试原取消操作，或在资产目录核对草稿。';
      this.changed();
    } finally {
      this.controllers.delete(controller);
    }
  }
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.listeners.clear();
  }
}
