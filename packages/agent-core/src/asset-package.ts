import { z } from 'zod';
import { parseDocument } from 'yaml';

export const ASSET_IMPORT_LIMITS = Object.freeze({
  files: 100,
  items: 20,
  fileBytes: 262144,
  totalBytes: 2097152,
  skillChars: 60000,
  expertChars: 32000,
});
export class AssetImportError extends Error {}
function fail(message: string): never {
  throw new AssetImportError(message);
}
const resourceId = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[\w-]+$/u);
export function validPackagePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 400 &&
    !/[\\:\u0000-\u001f\u007f]/u.test(path) &&
    path.split('/').every((s) => !!s && s !== '.' && s !== '..' && !/[. ]$/u.test(s))
  );
}
export const PackagePathSchema = z
  .string()
  .refine(validPackagePath, '需要包内相对路径，不能包含越界或绝对路径。');
export function privatePackagePath(path: string): boolean {
  return (
    path
      .split('/')
      .some((s) =>
        /^(?:\.(?:git|ssh|aws|codex|openclaw)|\.env(?:\..*)?|USER\.md|MEMORY\.md|memory|sessions?|credentials?(?:\..*)?|auth(?:\..*)?|id_(?:rsa|ed25519)(?:\..*)?)$/iu.test(
          s,
        ),
      ) || /\.(?:pem|key|p12|pfx)$/iu.test(path)
  );
}
export const PackageFileSchema = z.strictObject({
  path: PackagePathSchema,
  data: z
    .string()
    .max(349528)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u, '文件编码无效。'),
});
export type PackageFile = z.infer<typeof PackageFileSchema>;
export const PackageFilesSchema = z.array(PackageFileSchema).min(1).max(ASSET_IMPORT_LIMITS.files);
export const PackageUploadSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('files'), files: PackageFilesSchema }),
  z.strictObject({
    kind: z.literal('zip'),
    data: z
      .string()
      .max(2796204)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
  }),
]);
export type PackageUpload = z.infer<typeof PackageUploadSchema>;
export const ResourceFilesReplySchema = z.strictObject({
  versionId: z.uuid(),
  files: PackageFilesSchema,
});
export const StoredAssetPackageSchema = z.strictObject({
  versionId: z.uuid(),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  files: PackageFilesSchema,
});
export type StoredAssetPackage = z.infer<typeof StoredAssetPackageSchema>;
export const ResourceOriginSchema = z.strictObject({
  versionId: z.uuid(),
  format: z.enum(['agent-skill', 'openclaw', 'zhuma-expert', 'workflow']),
  entryPath: PackagePathSchema,
  filePaths: z.array(PackagePathSchema).min(1).max(ASSET_IMPORT_LIMITS.files),
  totalBytes: z.number().int().nonnegative().max(ASSET_IMPORT_LIMITS.totalBytes),
  missing: z.array(z.string().max(600)).max(100),
  sourceVersion: z.string().max(80).optional(),
  sourceId: resourceId.optional(),
});
export type ResourceOrigin = z.infer<typeof ResourceOriginSchema>;
export const ImportChoiceSchema = z.strictObject({
  key: PackagePathSchema,
  id: resourceId,
  replace: z.boolean(),
  name: z.string().trim().min(1).max(160),
  description: z.string().max(8000),
  role: z.string().max(300),
  capabilities: z.array(z.string().trim().min(1).max(80)).max(30),
  available: z.boolean(),
});
export const ImportPackageInputSchema = z.strictObject({
  versionId: z.uuid(),
  files: PackageFilesSchema,
  choices: z.array(ImportChoiceSchema).min(1).max(ASSET_IMPORT_LIMITS.items),
});
export type ImportPackageInput = z.infer<typeof ImportPackageInputSchema>;
export const ImportPackageItemSchema = z.strictObject({
  key: PackagePathSchema,
  kind: z.enum(['skill', 'expert', 'template']),
  format: ResourceOriginSchema.shape.format,
  name: z.string().max(160),
  description: z.string().max(8000),
  content: z.string().max(150000),
  role: z.string().max(300),
  capabilities: z.array(z.string().max(80)).max(30),
  filePaths: z.array(PackagePathSchema).max(100),
  missing: z.array(z.string().max(600)).max(100),
  requirements: z.array(z.string().max(600)).max(100),
  skillKeys: z.array(PackagePathSchema).max(100),
  sourceId: resourceId.optional(),
  sourceVersion: z.string().max(80).optional(),
});
export const ImportPackagePreviewSchema = z.strictObject({
  items: z.array(ImportPackageItemSchema).min(1).max(20),
  files: PackageFilesSchema,
  ignored: z
    .array(z.strictObject({ path: PackagePathSchema, reason: z.string().max(200) }))
    .max(100),
});
export type ImportPackageItem = z.infer<typeof ImportPackageItemSchema>;
export type ImportPackagePreview = z.infer<typeof ImportPackagePreviewSchema>;
export function packageFileBytes(file: PackageFile): number {
  return (
    (file.data.length * 3) / 4 - (file.data.endsWith('==') ? 2 : file.data.endsWith('=') ? 1 : 0)
  );
}
export function packageFileText(file: PackageFile): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(atob(file.data), (s) => s.charCodeAt(0)),
    );
  } catch {
    return fail(`「${file.path}」需要有效的 UTF-8 文字。`);
  }
}
function parent(path: string): string {
  return path.split('/').slice(0, -1).join('/');
}
function inFolder(path: string, folder: string): boolean {
  return folder ? path.startsWith(`${folder}/`) : true;
}
function resolveReference(base: string, ref: string): string | null {
  if (/^(?:[a-z]+:|\/|#)/iu.test(ref)) return null;
  let value: string;
  try {
    value = decodeURIComponent(ref.split(/[?#]/u)[0]!);
  } catch {
    return null;
  }
  const parts = base ? base.split('/') : [];
  for (const part of value.split('/')) {
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else if (part && part !== '.') parts.push(part);
  }
  const path = parts.join('/');
  return validPackagePath(path) ? path : null;
}

function markdownReferences(text: string): string[] {
  const refs: string[] = [];
  let label = -1;
  // A bounded linear scan avoids regex backtracking on bracket-heavy source text.
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] === '[') label = i;
    if (text[i] !== ']' || text[i + 1] !== '(' || label < 0) continue;
    const end = text.indexOf(')', i + 2);
    if (end < 0) break;
    const ref = text
      .slice(i + 2, end)
      .trim()
      .split(/\s/u, 1)[0];
    if (ref) refs.push(ref);
    i = end;
    label = -1;
  }
  return refs;
}

/** Static definitions only. Uploaded instructions are data, never instructions to this importer. */
export function previewResourcePackage(
  raw: unknown,
  validateWorkflow?: (content: string) => unknown,
): ImportPackagePreview {
  const parsed = PackageFilesSchema.safeParse(raw);
  if (!parsed.success)
    return fail('文件清单、路径或编码无效；最多 100 个文件，单文件最多 256 KiB。');
  const seen = new Set<string>();
  let bytes = 0;
  const ignored: ImportPackagePreview['ignored'] = [];
  const files = parsed.data.filter((file) => {
    const key = file.path.normalize('NFC').toLowerCase();
    if (seen.has(key)) fail(`存在重复或大小写冲突路径：${file.path}`);
    seen.add(key);
    const size = packageFileBytes(file);
    if (size > ASSET_IMPORT_LIMITS.fileBytes) fail(`「${file.path}」超过 256 KiB。`);
    bytes += size;
    if (bytes > ASSET_IMPORT_LIMITS.totalBytes) fail('解压后总量超过 2 MiB。');
    if (privatePackagePath(file.path)) {
      ignored.push({ path: file.path, reason: '私人资料或凭据，不导入' });
      return false;
    }
    return true;
  });
  const byPath = new Map(files.map((f) => [f.path, f]));
  const items: ImportPackageItem[] = [];
  const consumed = new Set<string>();
  function add(item: ImportPackageItem) {
    if (items.length >= ASSET_IMPORT_LIMITS.items) fail('一次最多导入 20 项定义，请拆分资产包。');
    const legal = files
      .filter(
        (f) =>
          /^(?:licen[sc]e|notice|copying|copyright|readme)(?:\..*)?$/iu.test(
            f.path.split('/').at(-1)!,
          ) &&
          (!parent(f.path) || inFolder(item.key, parent(f.path))),
      )
      .map((f) => f.path);
    item.filePaths = [...new Set([...item.filePaths, ...legal])];
    const result = ImportPackageItemSchema.safeParse(item);
    if (!result.success) fail(`「${item.key}」定义超出内容或数量限制，请拆分后导入。`);
    result.data.filePaths.forEach((path) => consumed.add(path));
    items.push(result.data);
  }
  for (const file of files.filter((f) => f.path.split('/').at(-1) === 'SKILL.md')) {
    const text = packageFileText(file).replace(/^\uFEFF/u, '');
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(text);
    if (!match) fail(`「${file.path}」缺少 YAML 元数据区。`);
    const doc = parseDocument(match![1]!, { schema: 'failsafe', strict: true, uniqueKeys: true });
    if (doc.errors.length || doc.warnings.length)
      fail(`「${file.path}」元数据格式无效或含不支持的标签。`);
    let meta: Record<string, unknown>;
    try {
      meta = z.record(z.string(), z.unknown()).parse(doc.toJS({ maxAliasCount: 0 }));
    } catch {
      return fail(`「${file.path}」元数据必须是静态键值，不支持别名。`);
    }
    const name = z.string().min(1).max(64).safeParse(meta.name);
    const desc = z.string().trim().min(1).max(1024).safeParse(meta.description);
    if (
      !z
        .strictObject({
          license: z.string().max(2000).optional(),
          compatibility: z.string().max(500).optional(),
          'allowed-tools': z.string().max(2000).optional(),
          metadata: z.record(z.string(), z.string()).optional(),
        })
        .safeParse({
          license: meta.license,
          compatibility: meta.compatibility,
          'allowed-tools': meta['allowed-tools'],
          metadata: meta.metadata,
        }).success
    )
      fail(`「${file.path}」的可选元数据类型或长度无效。`);
    if (
      !name.success ||
      name.data.toLowerCase() !== name.data ||
      !/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(name.data) ||
      !desc.success
    )
      fail(`「${file.path}」需要有效的小写 name 和非空 description。`);
    const folder = parent(file.path);
    if (folder && folder.split('/').at(-1) !== name.data)
      fail(`「${file.path}」的 name 必须与目录名一致。`);
    const content = match![2]!.trim();
    if (!content || text.length > ASSET_IMPORT_LIMITS.skillChars)
      fail(`「${file.path}」需要正文，且不得超过 60000 字符。`);
    const paths = files.filter((f) => inFolder(f.path, folder)).map((f) => f.path);
    const missing: string[] = [];
    for (const ref of markdownReferences(content)) {
      if (/^(?:[a-z]+:|\/|#)/iu.test(ref)) continue;
      const target = resolveReference(folder, ref);
      if (!target || !paths.includes(target)) missing.push(ref);
    }
    const requirements = Object.keys(meta)
      .filter(
        (k) =>
          ![
            'name',
            'description',
            'license',
            'compatibility',
            'metadata',
            'allowed-tools',
          ].includes(k),
      )
      .map((k) => `未映射的元数据：${k}`);
    if (meta.compatibility)
      requirements.push(`环境要求：${String(meta.compatibility).slice(0, 500)}`);
    if (meta['allowed-tools'])
      requirements.push(`工具声明不授予权限：${String(meta['allowed-tools']).slice(0, 500)}`);
    add({
      key: file.path,
      kind: 'skill',
      format: 'agent-skill',
      name: name.data,
      description: desc.data,
      content,
      role: '',
      capabilities: [],
      filePaths: paths,
      missing: [...new Set(missing)],
      requirements,
      skillKeys: [],
    });
  }
  for (const file of files.filter((f) => f.path.split('/').at(-1) === 'SOUL.md')) {
    const folder = parent(file.path);
    const siblings = ['SOUL.md', 'IDENTITY.md', 'AGENTS.md']
      .map((n) => (folder ? `${folder}/${n}` : n))
      .filter((p) => byPath.has(p));
    const identity = siblings.find((p) => p.endsWith('IDENTITY.md'));
    const identityText = identity ? packageFileText(byPath.get(identity)!) : '';
    const name =
      /^\s*[-*]?\s*\*{0,2}Name\s*:\*{0,2}\s*(.+)$/imu
        .exec(identityText)?.[1]
        ?.trim()
        .slice(0, 160) || '导入专家';
    const content = siblings
      .filter((p) => !p.endsWith('IDENTITY.md'))
      .map((p) => `## ${p.split('/').at(-1)}\n\n${packageFileText(byPath.get(p)!).trim()}`)
      .join('\n\n');
    if (!packageFileText(file).trim() || content.length > ASSET_IMPORT_LIMITS.expertChars)
      fail(`「${file.path}」需要人格正文；合并后最多 32000 字符。`);
    const skillKeys = items
      .filter((i) => i.kind === 'skill' && inFolder(i.key, folder ? `${folder}/skills` : 'skills'))
      .map((i) => i.key);
    add({
      key: file.path,
      kind: 'expert',
      format: 'openclaw',
      name,
      description: 'OpenClaw 人格与方法定义',
      content,
      role: '自定义专家',
      capabilities: [],
      filePaths: siblings,
      missing: [],
      requirements: identity ? [] : ['未提供 IDENTITY.md，可补充专家名称'],
      skillKeys,
    });
  }
  const expert = z.strictObject({
    format: z.literal('zhuma-expert'),
    schemaVersion: z.literal(1),
    id: resourceId.optional(),
    version: z.string().max(80).optional(),
    name: z.string().trim().min(1).max(160),
    role: z.string().max(300),
    capabilities: z.array(z.string().min(1).max(80)).max(30),
    instructions: z.string().min(1).max(ASSET_IMPORT_LIMITS.expertChars),
    skillPaths: z.array(PackagePathSchema).max(30).optional(),
  });
  for (const file of files.filter((f) => f.path.endsWith('.json') && !consumed.has(f.path))) {
    let value: unknown;
    try {
      value = JSON.parse(packageFileText(file));
    } catch {
      continue;
    }
    if (!value || typeof value !== 'object' || !('format' in value)) continue;
    if (value.format === 'zhuma-expert') {
      const result = expert.safeParse(value);
      if (!result.success) fail(`「${file.path}」专家定义无效或含不支持字段；不会安装插件配置。`);
      const d = result.data;
      const refs = (d.skillPaths ?? []).map((p) => resolveReference(parent(file.path), p) ?? p);
      const missing = refs.filter((p) => !items.some((i) => i.key === p && i.kind === 'skill'));
      add({
        key: file.path,
        kind: 'expert',
        format: 'zhuma-expert',
        name: d.name,
        description: 'Zhuma 专家定义',
        content: d.instructions,
        role: d.role,
        capabilities: d.capabilities,
        filePaths: [file.path],
        missing,
        requirements: [],
        skillKeys: refs,
        ...(d.id ? { sourceId: d.id } : {}),
        ...(d.version ? { sourceVersion: d.version } : {}),
      });
    } else if (value.format === 'zhuma-workflow-template') {
      if (!validateWorkflow) fail('工作流校验器不可用，不能导入。');
      try {
        validateWorkflow(packageFileText(file));
      } catch {
        fail(`「${file.path}」工作流定义或依赖无效。`);
      }
      add({
        key: file.path,
        kind: 'template',
        format: 'workflow',
        name: file.path
          .split('/')
          .at(-1)!
          .replace(/\.json$/u, ''),
        description: '结构化工作流',
        content: packageFileText(file),
        role: '',
        capabilities: [],
        filePaths: [file.path],
        missing: [],
        requirements: [],
        skillKeys: [],
      });
    }
  }
  if (!items.length) fail('未识别到 SKILL.md、SOUL.md 或 Zhuma 专家／工作流定义。');
  for (const file of files)
    if (!consumed.has(file.path))
      ignored.push({ path: file.path, reason: '不属于已识别定义，不导入' });
  return { items, files: files.filter((f) => consumed.has(f.path)), ignored };
}
