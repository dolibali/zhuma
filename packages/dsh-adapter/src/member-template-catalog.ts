import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AssetSchema, WorkbenchError, type TeamAsset } from '@zhuma/agent-core';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const ENGINEERING_WORKFLOW_SOURCE = '133276e2014bf1bcbd8410bab7bb339c929de46d';
const pins = new Map([
  [
    'zhuma-eng-requirements-to-test',
    '05889adea412b2bbbc2d8d1fbb728e5dda6e2de1fb8e9a66b3cb76c284282b4d',
  ],
  ['zhuma-eng-design-to-plan', '7668b76b1e105ee7460d438b3bac0d68d130001370d8ce186f5da72365a0dc92'],
  [
    'zhuma-eng-review-fix-verify',
    '6f74d69dbfb2e7ed149f8b4a60f09d1a0d0a064f85bbfe672da4b0a8511a1378',
  ],
  ['zhuma-eng-sources-to-docs', '6341c51355b7f023cf06e0da6f3d80ca4a428d22918faf072e1c60886e9720dd'],
]);
export const DefaultMemberTemplatesSchema = z.strictObject({
  sourceCommit: z.literal(ENGINEERING_WORKFLOW_SOURCE),
  assets: z.array(AssetSchema).length(4),
});
export type DefaultMemberTemplates = z.infer<typeof DefaultMemberTemplatesSchema>;

/** A supplies exact public build bytes privately; no Config/HTTP input, import or write. */
export function defaultMemberTemplates(raw: unknown): readonly TeamAsset[] {
  const parsed = DefaultMemberTemplatesSchema.safeParse(raw);
  if (
    !parsed.success ||
    new Set(parsed.data.assets.map((asset) => asset.id)).size !== 4 ||
    parsed.data.assets.some(
      (asset) =>
        asset.kind !== 'template' ||
        !asset.available ||
        asset.memberTemplate ||
        pins.get(asset.id) !== hash(asset.content),
    )
  )
    throw new WorkbenchError('unavailable', '默认工作流来源暂不可用。');
  return structuredClone(parsed.data.assets);
}

/** Exact original built-in source pin, not a member owner or publication UUID. */
export function defaultMemberTemplateSource(asset: TeamAsset) {
  if (
    asset.kind !== 'template' ||
    !asset.available ||
    asset.memberTemplate ||
    asset.origin ||
    pins.get(asset.id) !== hash(asset.content)
  )
    return undefined;
  return { sourceCommit: ENGINEERING_WORKFLOW_SOURCE, sha256: hash(asset.content) };
}

/** Projection only. Caller proves live membership/personal ownership; legacy assets grant nothing. */
export function ownedMemberTemplates(
  assets: readonly TeamAsset[],
  scope: { spaceId: string; actorId: string; kind: 'personal' | 'team'; personalOwner?: string },
): readonly TeamAsset[] {
  return assets.filter(
    (asset) =>
      asset.kind === 'template' &&
      asset.memberTemplate?.spaceId === scope.spaceId &&
      (scope.kind === 'team' ||
        (scope.personalOwner === scope.actorId && asset.memberTemplate.ownerId === scope.actorId)),
  );
}
