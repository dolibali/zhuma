import { createHash } from 'node:crypto';
import { canonicalPayload, type TeamAsset } from '@zhuma/agent-core';
import {
  defaultMemberEngineeringSkillSource,
  ENGINEERING_SKILL_SOURCE,
} from './member-engineering-skill-catalog.js';

/** Complete public TeamAsset definitions emitted by the v1.4 catalog builder.
 * Source 133276e2014bf1bcbd8410bab7bb339c929de46d: resources/workflows/engineering-starter/catalog.json
 * and each resources/skills/engineering-starter folder's SKILL.md and LICENSE.txt.
 * These digests recognize exact old rows; an ID, body, or self-declared origin is insufficient.
 */
const legacyDefinitions: ReadonlyMap<string, string> = new Map([
  [
    'zhuma-eng-requirements-analysis',
    'f5494976aee97d69a350802cb6db17c82b4d108fd41ed031a7dd979e0c338f04',
  ],
  ['zhuma-eng-delivery-plan', '9e12a5f6c1180b06e10c6d97653d0ab9a669378866552541d32ba21be0d53d0a'],
  ['zhuma-eng-test-design', '25db62bd40e76c2a95456568f1498436b4c90744b45829d3a1b58e24dea74f42'],
  [
    'zhuma-eng-acceptance-review',
    '09a1351bcd9091cb7d772f1d3737e1c5c425fe0aaca4bb30b0e9f036ed4df4fa',
  ],
  ['zhuma-eng-solution-design', '7ac6d1f54cb25ec281e5b0cd29a004d5c5976e74f401716311eddca4a214983e'],
  ['zhuma-eng-change-review', '58c8b288671cf6f03700492334915a33575df970f2e964dd0e720d7b5864470d'],
  ['zhuma-eng-bounded-fix', 'b2a4bf39521e1f4581308dbf5aba2117b799c186fa57db2160df98aa955a4d5f'],
  [
    'zhuma-eng-focused-verification',
    'd851577eef8e71a4f6aafdf28d7c2945e91c47aca2f1291a4544ee9f563d84c0',
  ],
  ['zhuma-eng-source-curation', 'c48eeceedaa1aa2fd7852f88625c9bc1eb24b367161f785ee7fa87882284b0e4'],
  [
    'zhuma-eng-engineering-writing',
    '9f1aeba95d86478a399c5358eb9057e4b7fdccb6b9f75feab6ca59dc24badefc',
  ],
]);
const definitionDigest = (asset: TeamAsset) =>
  createHash('sha256').update(canonicalPayload(asset)).digest('hex');

/** A compatibility check only. Caller must already hold a live authorized catalog.
 * It never grants resources, edits fixed plans, or accepts arbitrary future replacements.
 */
export function canUpgradeBuiltinAsset(previous: TeamAsset, current: TeamAsset): boolean {
  if (
    previous.id !== current.id ||
    previous.kind !== 'skill' ||
    current.kind !== 'skill' ||
    previous.origin ||
    previous.memberAsset ||
    previous.memberTemplate ||
    current.origin ||
    current.memberAsset ||
    current.memberTemplate ||
    legacyDefinitions.get(previous.id) !== definitionDigest(previous)
  )
    return false;
  const source = defaultMemberEngineeringSkillSource(current);
  return (
    source !== undefined &&
    source.sourceCommit === ENGINEERING_SKILL_SOURCE &&
    source.definitionSha256 === definitionDigest(current)
  );
}
