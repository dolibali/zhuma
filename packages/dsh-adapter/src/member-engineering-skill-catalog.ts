import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AssetSchema, canonicalPayload, WorkbenchError, type TeamAsset } from '@zhuma/agent-core';

export const ENGINEERING_SKILL_SOURCE = '583472338143c5d02f94ec97e0d9eb6dc8dfa76e';
const pins = new Map([
  [
    'zhuma-eng-requirements-analysis',
    '4d1ceff638d52baecafe5f092c3f5fe9bf7a3c7742a94b3ffce6905f2e126bb9',
  ],
  ['zhuma-eng-delivery-plan', '3c760eaab9b78454dfc4c54d7899833be8c050810411ad8348acb2c08b7de13e'],
  ['zhuma-eng-test-design', 'c8c4e636ee9d254493ad827c28dbc3f1e19797579266c31e1756b93cfdbde864'],
  [
    'zhuma-eng-acceptance-review',
    'ecd2124cfcc15b4bf75b2dac742a612a9dfa5fd5828d51184dfd91772fae2a90',
  ],
  ['zhuma-eng-solution-design', '3f14d8ead0887475fc872b589a9e6a612b3bc070695aa85b20a277b67133da25'],
  ['zhuma-eng-change-review', 'ed6afc4433101d7ae524a8e8d5dcb95f39836255293bcc26fe718a2d8543dbbd'],
  ['zhuma-eng-bounded-fix', 'd529c14b8e3ef4b4a5447418ca61d22c77e62c3d346f2a9a378de6dea5964b00'],
  [
    'zhuma-eng-focused-verification',
    'baf1d5cadf4ae574caae535fd8087ecd32ff231fd3f7d4c8886548c01ae51000',
  ],
  ['zhuma-eng-source-curation', '7e332a4bebfffd60eb840ea301932052d4eac4e8cc3ca7aada62e274dff55704'],
  [
    'zhuma-eng-engineering-writing',
    '16cbdce08d399730faeafa2ab359326e303c7d045b44cd05dcb49d1865085f41',
  ],
  [
    'zhuma-eng-controlled-implementation',
    '7be26da842fcc5a1e17cfd0159133bd88f911f394998172b88b89d843552e1b2',
  ],
]);
// Canonical SHA-256 of each complete checked-in public TeamAsset definition,
// including its identity, metadata and body. Never derived from a queried asset.
const definitionPins = new Map([
  [
    'zhuma-eng-requirements-analysis',
    '4846dc7d6c6bda14a7548808e345ac863b204a13932a7b4697acb3ff241db7a1',
  ],
  ['zhuma-eng-delivery-plan', 'bbc1a0e8424cedb473bd113ee8dd12355cbbcba53d48e1da2dacf82d4bccaa3f'],
  ['zhuma-eng-test-design', '25db62bd40e76c2a95456568f1498436b4c90744b45829d3a1b58e24dea74f42'],
  [
    'zhuma-eng-acceptance-review',
    '60d07c68aa3dcf8ed925d429ea3dcf3b92176f6091c78140ae263b6b9292dfd6',
  ],
  ['zhuma-eng-solution-design', '485bb3b7004ae58cdf257ef2af6aa535ea859cc3db009562b21005ad182a6337'],
  ['zhuma-eng-change-review', 'd55776fa4e294053580e7ef4265c8d32828790270185d97563aca572c5a9c6c6'],
  ['zhuma-eng-bounded-fix', 'a0fafe2953f473ff03b61e895635b99d42593fce836c56912b28f447f05f46fd'],
  [
    'zhuma-eng-focused-verification',
    'dc1396d0d51ba56c1b75d17cb0807944a75af6380f26c75aaf9fc6add323015a',
  ],
  ['zhuma-eng-source-curation', 'c48eeceedaa1aa2fd7852f88625c9bc1eb24b367161f785ee7fa87882284b0e4'],
  [
    'zhuma-eng-engineering-writing',
    'd684dce7c998a11af2e8723dbd68e1a30c85cf9ab1ae558ccdb430da19f310aa',
  ],
  [
    'zhuma-eng-controlled-implementation',
    'c098e814f5f13e6b12a3a8c8edf0d4092e7a6b506be918d6eaaf14d9c95b6bb6',
  ],
]);
export const DefaultMemberEngineeringSkillsSchema = z.strictObject({
  sourceCommit: z.literal(ENGINEERING_SKILL_SOURCE),
  assets: z.array(AssetSchema).length(11),
});
export type DefaultMemberEngineeringSkills = z.infer<typeof DefaultMemberEngineeringSkillsSchema>;

/** A privately embeds the pinned public SKILL.md bytes and retains their source LICENSE files.
 * No file read, import, origin/versionId, member grant, tool permission or execution occurs here. */
export function defaultMemberEngineeringSkills(raw: unknown): readonly TeamAsset[] {
  const parsed = DefaultMemberEngineeringSkillsSchema.safeParse(raw);
  if (
    !parsed.success ||
    new Set(parsed.data.assets.map((asset) => asset.id)).size !== 11 ||
    parsed.data.assets.some(
      (asset) =>
        asset.kind !== 'skill' ||
        !asset.available ||
        Object.hasOwn(asset, 'origin') ||
        Object.hasOwn(asset, 'memberTemplate') ||
        pins.get(asset.id) !== createHash('sha256').update(asset.content).digest('hex'),
    )
  )
    throw new WorkbenchError('unavailable', '默认工程 Skill 来源暂不可用。');
  const assets = new Map(parsed.data.assets.map((asset) => [asset.id, asset]));
  return [...pins.keys()].map((id) => structuredClone(assets.get(id)!));
}

/** Package-private source proof for the bounded upgrade of known public definitions.
 * It grants no member authority and accepts neither caller-supplied pins nor aliases. */
export function defaultMemberEngineeringSkillSource(
  asset: TeamAsset,
): { readonly sourceCommit: string; readonly definitionSha256: string } | undefined {
  if (
    !AssetSchema.safeParse(asset).success ||
    asset.kind !== 'skill' ||
    !asset.available ||
    Object.hasOwn(asset, 'origin') ||
    Object.hasOwn(asset, 'memberAsset') ||
    Object.hasOwn(asset, 'memberTemplate')
  )
    return undefined;
  const definitionSha256 = createHash('sha256').update(canonicalPayload(asset)).digest('hex');
  if (definitionPins.get(asset.id) !== definitionSha256) return undefined;
  return { sourceCommit: ENGINEERING_SKILL_SOURCE, definitionSha256 };
}

/** Only merge a Host's already authorized catalog. Never pass the legacy global asset list as a grant.
 * Exact duplicates keep the original row; collisions cannot overwrite or assume a source. */
export function mergeDefaultMemberEngineeringSkills(
  current: readonly TeamAsset[],
  raw: unknown,
): readonly TeamAsset[] {
  const existing = z.array(AssetSchema).max(100).safeParse(current);
  if (
    !existing.success ||
    new Set(existing.data.map((asset) => asset.id)).size !== existing.data.length
  )
    throw new WorkbenchError('resource-conflict', '授权资源目录存在冲突。');
  const merged = new Map(existing.data.map((asset) => [asset.id, asset]));
  for (const asset of defaultMemberEngineeringSkills(raw)) {
    const prior = merged.get(asset.id);
    if (prior && canonicalPayload(prior) !== canonicalPayload(asset))
      throw new WorkbenchError('resource-conflict', '默认工程 Skill 与已有同标识定义冲突。');
    if (!prior) merged.set(asset.id, asset);
  }
  if (merged.size > 100) throw new WorkbenchError('unavailable', '授权资源目录超过当前范围。');
  return structuredClone([...merged.values()]);
}
