import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AssetSchema, canonicalPayload, WorkbenchError, type TeamAsset } from '@zhuma/agent-core';

export const ENGINEERING_SKILL_SOURCE = '133276e2014bf1bcbd8410bab7bb339c929de46d';
const pins = new Map([
  [
    'zhuma-eng-requirements-analysis',
    '23754e8c676cca599706022c20d2a2742f21e4aa81146ef5e3ea2913843629df',
  ],
  ['zhuma-eng-delivery-plan', 'efa97092bd29686dc508e178a16904b054b0abbba6f552ada135c927cec976e8'],
  ['zhuma-eng-test-design', 'c8c4e636ee9d254493ad827c28dbc3f1e19797579266c31e1756b93cfdbde864'],
  [
    'zhuma-eng-acceptance-review',
    'aeec9eceacc40eec74de092c4d330c83ffc1ca7f04b026a6753d464b865a0f33',
  ],
  ['zhuma-eng-solution-design', '05ad2f92580f83b6e7c2c06dff8c8f0797cc370c253e1870ca09bfcd79cbb54c'],
  ['zhuma-eng-change-review', 'b65d1a963c3c273a4d63771ff6da61fc843da039d7a4709340a2becc0c7d3419'],
  ['zhuma-eng-bounded-fix', '2e979ac765b5cadf345c6b8e8999cdc7195bd00fb12811c19496dc1fa7c06568'],
  [
    'zhuma-eng-focused-verification',
    '0655b1ded6d2637f5f35f0bff26aea7460c0ff499818cea1e97278f44abc8109',
  ],
  ['zhuma-eng-source-curation', '7e332a4bebfffd60eb840ea301932052d4eac4e8cc3ca7aada62e274dff55704'],
  [
    'zhuma-eng-engineering-writing',
    'edc5303d2c94134083c06d917b051bb4920a9ef1e95cf702b5f882cd1a2d7903',
  ],
]);
export const DefaultMemberEngineeringSkillsSchema = z.strictObject({
  sourceCommit: z.literal(ENGINEERING_SKILL_SOURCE),
  assets: z.array(AssetSchema).length(10),
});
export type DefaultMemberEngineeringSkills = z.infer<typeof DefaultMemberEngineeringSkillsSchema>;

/** A privately embeds the pinned public SKILL.md bytes and retains their source LICENSE files.
 * No file read, import, origin/versionId, member grant, tool permission or execution occurs here. */
export function defaultMemberEngineeringSkills(raw: unknown): readonly TeamAsset[] {
  const parsed = DefaultMemberEngineeringSkillsSchema.safeParse(raw);
  if (
    !parsed.success ||
    new Set(parsed.data.assets.map((asset) => asset.id)).size !== 10 ||
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
