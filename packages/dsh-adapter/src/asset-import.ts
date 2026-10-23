import { fromBuffer, type ZipFile, type Entry } from 'yauzl';
import { crc32 } from 'node:zlib';
import type { Readable } from 'node:stream';
import {
  PackageUploadSchema,
  previewResourcePackage,
  parseWorkflowTemplate,
  privatePackagePath,
  validPackagePath,
  ASSET_IMPORT_LIMITS,
  WorkbenchError,
  type PackageFile,
  type ImportPackagePreview,
} from '@zhuma/agent-core';

/** Read ZIP entries into memory only; no host path, extraction, chmod or execution. */
export async function readImportArchive(data: string, signal: AbortSignal): Promise<PackageFile[]> {
  signal.throwIfAborted();
  const buffer = Buffer.from(data, 'base64');
  if (buffer.byteLength > ASSET_IMPORT_LIMITS.totalBytes)
    throw new WorkbenchError('asset-limit', 'ZIP 文件超过 2 MiB。');
  return new Promise((resolve, reject) => {
    let zip: ZipFile | undefined;
    let stream: Readable | undefined;
    let settled = false;
    const files: PackageFile[] = [];
    const seen = new Set<string>();
    let total = 0;
    const abort = () => fail(new WorkbenchError('cancelled', '导入预览已取消。'));
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      stream?.destroy();
      zip?.close();
      reject(
        error instanceof WorkbenchError
          ? error
          : new WorkbenchError('asset-archive', 'ZIP 无效、已加密或损坏，请重新打包普通文件。'),
      );
    };
    signal.addEventListener('abort', abort, { once: true });
    fromBuffer(
      buffer,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, opened) => {
        if (error || !opened) return fail(error);
        zip = opened;
        if (settled) {
          zip.close();
          return;
        }
        zip.on('error', fail);
        if (zip.entryCount > ASSET_IMPORT_LIMITS.files * 2)
          return fail(
            new WorkbenchError('asset-limit', 'ZIP 条目过多，最多 100 个文件及 100 个目录。'),
          );
        zip.on('entry', (entry: Entry) => {
          void (async () => {
            signal.throwIfAborted();
            const directory = entry.fileName.endsWith('/');
            const path = directory ? entry.fileName.slice(0, -1) : entry.fileName;
            const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
            if (
              !validPackagePath(path) ||
              ![0, 0o100000, 0o040000].includes(mode) ||
              entry.extraFields.some((f) => [0x000d, 0x756e].includes(f.id))
            )
              throw new WorkbenchError('asset-path', 'ZIP 含越界路径、链接或特殊文件，不能导入。');
            const key = path.normalize('NFC').toLowerCase();
            if (seen.has(key)) throw new WorkbenchError('asset-path', `ZIP 含重复路径：${path}`);
            seen.add(key);
            if (entry.isEncrypted() || ![0, 8].includes(entry.compressionMethod))
              throw new WorkbenchError('asset-archive', '不支持加密 ZIP 或此压缩算法。');
            total += entry.uncompressedSize;
            if (
              entry.uncompressedSize > ASSET_IMPORT_LIMITS.fileBytes ||
              total > ASSET_IMPORT_LIMITS.totalBytes
            )
              throw new WorkbenchError('asset-limit', '单文件最多 256 KiB，解压后总量最多 2 MiB。');
            if (!directory) {
              if (files.length >= ASSET_IMPORT_LIMITS.files)
                throw new WorkbenchError('asset-limit', '一次最多 100 个文件。');
              if (privatePackagePath(path)) files.push({ path, data: '' });
              else {
                stream = await new Promise<Readable>((res, rej) =>
                  zip!.openReadStream(entry, (err, readable) =>
                    err || !readable ? rej(err) : res(readable),
                  ),
                );
                const chunks: Buffer[] = [];
                let length = 0;
                for await (const chunk of stream) {
                  signal.throwIfAborted();
                  const bytes = Buffer.from(chunk);
                  length += bytes.byteLength;
                  if (length > ASSET_IMPORT_LIMITS.fileBytes || length > entry.uncompressedSize)
                    throw new WorkbenchError('asset-limit', 'ZIP 实际解压数据超过声明大小或限制。');
                  chunks.push(bytes);
                }
                const bytes = Buffer.concat(chunks);
                if (length !== entry.uncompressedSize || crc32(bytes) !== entry.crc32)
                  throw new WorkbenchError('asset-archive', `「${path}」完整性校验失败。`);
                files.push({ path, data: bytes.toString('base64') });
              }
            }
            if (!settled) zip!.readEntry();
          })().catch(fail);
        });
        zip.on('end', () => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', abort);
          resolve(files);
        });
        if (signal.aborted) abort();
        else zip.readEntry();
      },
    );
  });
}
export async function previewAssetImport(
  raw: unknown,
  signal: AbortSignal,
): Promise<ImportPackagePreview> {
  const source = PackageUploadSchema.parse(raw);
  const files = source.kind === 'zip' ? await readImportArchive(source.data, signal) : source.files;
  signal.throwIfAborted();
  return previewResourcePackage(files, parseWorkflowTemplate);
}
