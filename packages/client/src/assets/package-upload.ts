import {
  ASSET_IMPORT_LIMITS,
  privatePackagePath,
  validPackagePath,
  type PackageUpload,
} from '@zhuma/agent-core';

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768)
    binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(binary);
}
export async function readAssetPackageUpload(
  files: File[],
  signal: AbortSignal,
): Promise<PackageUpload> {
  if (!files.length || files.length > ASSET_IMPORT_LIMITS.files)
    throw Error('一次选择 1–100 个文件。');
  if (files.length === 1 && /\.zip$/iu.test(files[0]!.name)) {
    if (files[0]!.size > ASSET_IMPORT_LIMITS.totalBytes) throw Error('ZIP 文件最多 2 MiB。');
    const bytes = await files[0]!.arrayBuffer();
    signal.throwIfAborted();
    return { kind: 'zip', data: base64(new Uint8Array(bytes)) };
  }
  let total = 0;
  const seen = new Set<string>();
  for (const file of files) {
    const path = file.webkitRelativePath || file.name;
    if (!validPackagePath(path)) throw Error('文件路径无效，请选择普通文件或重新打包。');
    const key = path.normalize('NFC').toLowerCase();
    if (seen.has(key)) throw Error(`存在重复路径：${path}`);
    seen.add(key);
    total += file.size;
    if (file.size > ASSET_IMPORT_LIMITS.fileBytes || total > ASSET_IMPORT_LIMITS.totalBytes)
      throw Error('单文件最多 256 KiB，总量最多 2 MiB。');
    if (/\.zip$/iu.test(file.name)) throw Error('ZIP 需单独选择，不能与其他文件混合导入。');
  }
  const source: Extract<PackageUpload, { kind: 'files' }> = { kind: 'files', files: [] };
  for (const file of files) {
    signal.throwIfAborted();
    const path = file.webkitRelativePath || file.name;
    // Inspect names before reading: excluded private files are never read or uploaded.
    source.files.push({
      path,
      data: privatePackagePath(path) ? '' : base64(new Uint8Array(await file.arrayBuffer())),
    });
  }
  signal.throwIfAborted();
  return source;
}
