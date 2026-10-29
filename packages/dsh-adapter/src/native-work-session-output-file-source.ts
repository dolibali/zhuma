import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { FsInfo, FsTarget } from '@deepseek-ai/dsh-fs';
import { canonicalPayload } from '@zhuma/agent-core';
import { ARTIFACT_FILE_LIMITS, ArtifactUploadError } from './artifact-files.js';
import type { NativeWorkGrant } from './native-work-session-contract.js';
import type {
  NativeRunLocalToolProducer,
  NativeRunWorkspaceCapability,
} from './native-run-local-tools.js';
import type { NativeOutputPublicationAuthority } from './native-work-session-output-file-contract.js';

export function outputRelativePath(path: string): string {
  if (
    typeof path !== 'string' ||
    !path ||
    path.length > 4096 ||
    isAbsolute(path) ||
    /^[a-z]:/iu.test(path) ||
    /[\\\u0000-\u001f\u007f]/u.test(path) ||
    path.includes('://') ||
    path.split('/').some((p) => !p || p === '.' || p === '..')
  )
    throw new ArtifactUploadError('publication-denied');
  return path;
}
const contained = (root: string, target: string) => {
  const path = relative(root, target);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
};
function synchronous(value: unknown): void {
  if (value !== undefined) {
    void Promise.resolve(value).catch(() => undefined);
    throw new ArtifactUploadError('publication-denied');
  }
}
export interface NativeOutputFileRead {
  readonly maximumBytes: number;
  readonly signal: AbortSignal;
  check(): undefined;
  read(): Promise<{
    readonly bytes: Uint8Array;
    readonly sha256: string;
    readonly mediaType?: 'text/plain' | 'application/octet-stream';
  }>;
  close(): void;
  drain(): Promise<void>;
}

/** Original Host FS only. It never opens node:fs paths or advertises a filesystem snapshot. */
export class NativeOutputFileByteProducer {
  private readonly lifetime = new AbortController();
  private readonly operations = new Set<Promise<unknown>>();
  private readonly qualification: string;
  private readonly workspaceSignal: AbortSignal;
  private readonly publicationSignal: AbortSignal;
  constructor(
    private readonly producer: NativeRunLocalToolProducer,
    private readonly workspace: NativeRunWorkspaceCapability,
    private readonly publication: NativeOutputPublicationAuthority,
  ) {
    this.qualification = canonicalPayload({
      workspace: workspace.scope,
      root: workspace.root,
      publication: publication.scope,
      configurationId: publication.configurationId,
      paths: publication.paths,
    });
    this.workspaceSignal = workspace.signal;
    this.publicationSignal = publication.signal;
  }
  /** Lookup needs current publication authority but performs no FS stat/read. */
  authorize(grant: NativeWorkGrant, configurationId: string, path: string): undefined {
    return this.check(grant, configurationId, outputRelativePath(path));
  }
  private check(grant: NativeWorkGrant, configurationId: string, path: string): undefined {
    const p = this.publication,
      w = this.workspace;
    if (
      !p ||
      !w ||
      this.lifetime.signal.aborted ||
      p.signal.aborted ||
      w.signal.aborted ||
      grant.signal.aborted ||
      w.permissions.read !== true ||
      w.signal !== this.workspaceSignal ||
      p.signal !== this.publicationSignal ||
      this.qualification !==
        canonicalPayload({
          workspace: w.scope,
          root: w.root,
          publication: p.scope,
          configurationId: p.configurationId,
          paths: p.paths,
        }) ||
      canonicalPayload(p.scope) !== canonicalPayload(grant.scope) ||
      canonicalPayload(w.scope) !== canonicalPayload(grant.scope) ||
      p.configurationId !== configurationId ||
      !Array.isArray(p.paths) ||
      p.paths.length > 128 ||
      !p.paths.every((range) => range && ['file', 'directory'].includes(range.kind)) ||
      !p.paths.some((range) => {
        const selected = outputRelativePath(range.path);
        return path === selected || (range.kind === 'directory' && path.startsWith(`${selected}/`));
      })
    )
      throw new ArtifactUploadError('publication-denied');
    this.producer.assertCurrent();
    try {
      synchronous(grant.assertCurrent('send'));
      synchronous(w.assertCurrent('read'));
      synchronous(p.assertCurrent(path));
    } catch {
      throw new ArtifactUploadError('publication-denied');
    }
    return undefined;
  }
  async inspect(
    grant: NativeWorkGrant,
    configurationId: string,
    requested: string,
    caller: AbortSignal,
  ): Promise<NativeOutputFileRead> {
    const path = outputRelativePath(requested);
    this.check(grant, configurationId, path);
    const lifetime = new AbortController();
    const signal = AbortSignal.any([
      caller,
      grant.signal,
      this.lifetime.signal,
      this.producer.signal,
      this.workspace.signal,
      this.publication.signal,
      lifetime.signal,
      AbortSignal.timeout(ARTIFACT_FILE_LIMITS.uploadTimeoutMs),
    ]);
    const scope = canonicalPayload(grant.scope);
    const policy = canonicalPayload({ paths: this.publication.paths, root: this.workspace.root });
    const pending = new Set<Promise<unknown>>();
    const check = (): undefined => {
      if (signal.aborted) throw new ArtifactUploadError('cancelled');
      if (
        scope !== canonicalPayload(grant.scope) ||
        policy !== canonicalPayload({ paths: this.publication.paths, root: this.workspace.root })
      )
        throw new ArtifactUploadError('publication-denied');
      return this.check(grant, configurationId, path);
    };
    const own = async <T>(operation: Promise<T>): Promise<T> => {
      pending.add(operation);
      this.operations.add(operation);
      void operation.then(
        () => {
          pending.delete(operation);
          this.operations.delete(operation);
        },
        () => {
          pending.delete(operation);
          this.operations.delete(operation);
        },
      );
      check();
      let stop!: () => void;
      const aborted = new Promise<never>((_, reject) => {
        stop = () => reject(new ArtifactUploadError('cancelled'));
        signal.addEventListener('abort', stop, { once: true });
        if (signal.aborted) stop();
      });
      try {
        const value = await Promise.race([operation, aborted]);
        check();
        return value;
      } finally {
        signal.removeEventListener('abort', stop);
      }
    };
    const fs = this.producer.filesystem;
    const rootPath = this.workspace.root;
    if (!isAbsolute(rootPath) || fs.processPathFromHostPath(rootPath) === undefined)
      throw new ArtifactUploadError('publication-denied');
    const target = async (): Promise<FsTarget> => {
      check();
      const root = await own(fs.resolve(rootPath, { cwd: rootPath, signal }));
      const canonicalRoot = fs.processPath(root);
      if (!isAbsolute(canonicalRoot) || (await own(fs.stat(root, signal)))?.type !== 'directory')
        throw new ArtifactUploadError('publication-denied');
      // Reject every requested symlink component, including links within the workspace.
      const parts = path.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const info = await own(
          fs.lstat(parts.slice(0, i).join('/'), { cwd: canonicalRoot }, signal),
        );
        if (info?.type !== (i === parts.length ? 'file' : 'directory'))
          throw new ArtifactUploadError('publication-denied');
      }
      const result = await own(fs.resolve(path, { cwd: canonicalRoot, signal }));
      if (
        !contained(resolve(canonicalRoot), resolve(fs.processPath(result))) ||
        !fs.contains(root, result)
      )
        throw new ArtifactUploadError('publication-denied');
      return result;
    };
    const original = await target();
    const info = await own(fs.stat(original, signal));
    if (
      info?.type !== 'file' ||
      !Number.isSafeInteger(info.size) ||
      info.size! < 0 ||
      info.size! > ARTIFACT_FILE_LIMITS.maxFileBytes
    )
      throw new ArtifactUploadError('file-too-large');
    const initial = {
      target: original.targetKey,
      path: fs.processPath(original),
      version: info.version,
      size: info.size,
    };
    const unchanged = async (): Promise<void> => {
      const current = await target();
      const now: FsInfo | undefined = await own(fs.stat(current, signal));
      if (
        !now ||
        canonicalPayload({
          target: current.targetKey,
          path: fs.processPath(current),
          version: now.version,
          size: now.size,
        }) !== canonicalPayload(initial)
      )
        throw new ArtifactUploadError('source-changed');
    };
    let read = false;
    return {
      maximumBytes: info.size!,
      signal,
      check,
      read: async () => {
        if (read) throw new ArtifactUploadError('conflict');
        read = true;
        await unchanged();
        const bytes = await own(fs.readBytes(original, signal, ARTIFACT_FILE_LIMITS.maxFileBytes));
        await unchanged();
        check();
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== info.size)
          throw new ArtifactUploadError('source-changed');
        // Classify only a small set of passive text/code extensions. Share the
        // existing exact-object hash pass and original buffer; no extra FS read
        // or accumulated decoded document. A suffix alone never makes bytes text.
        const decoder = /\.(?:txt|md|json|csv|tsx?|jsx?|py|ya?ml)$/iu.test(path)
          ? new TextDecoder('utf-8', { fatal: true })
          : undefined;
        let plain = decoder !== undefined;
        const digest = createHash('sha256');
        for (let offset = 0; offset < bytes.byteLength; offset += 65536) {
          const chunk = bytes.subarray(offset, offset + 65536);
          digest.update(chunk);
          if (plain && decoder) {
            try {
              if (chunk.includes(0)) plain = false;
              else decoder.decode(chunk, { stream: true });
            } catch {
              plain = false;
            }
          }
        }
        if (plain && decoder) {
          try {
            decoder.decode();
          } catch {
            plain = false;
          }
        }
        check();
        return {
          bytes,
          sha256: digest.digest('hex'),
          mediaType: plain ? 'text/plain' : 'application/octet-stream',
        };
      },
      close: () => lifetime.abort(),
      drain: async () => {
        while (pending.size) await Promise.allSettled([...pending]);
      },
    };
  }
  async close(): Promise<void> {
    this.lifetime.abort();
    while (this.operations.size) await Promise.allSettled([...this.operations]);
  }
}
