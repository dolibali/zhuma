import type { PlanProposal } from './planning.js';
import { WorkbenchError, type TeamAsset, type Workbench, type WorkTask } from './workbench.js';

/** Character budgets, not model token estimates. Required work is never truncated. */
export const PLANNING_BUDGET = Object.freeze({
  contextChars: 90000,
  assetTextChars: 24000,
  assetExcerptChars: 4000,
  assets: 24,
  relatedAssets: 12,
} as const);

/** Local keyword retrieval supports English identifiers and adjacent Chinese characters. */
function terms(text: string): Set<string> {
  const result = new Set<string>();
  for (const word of text
    .normalize('NFKC')
    .toLowerCase()
    .match(/[\p{Script=Han}]+|[\p{L}\p{N}_-]{2,}/gu) ?? []) {
    if (/^\p{Script=Han}+$/u.test(word)) {
      const chars = [...word];
      for (let i = 0; i + 1 < chars.length; i++) result.add(chars[i]! + chars[i + 1]!);
    } else result.add(word);
  }
  return result;
}

function overlap(query: ReadonlySet<string>, text: string): number {
  let score = 0;
  for (const term of terms(text)) if (query.has(term)) score++;
  return score;
}

function excerpt(text: string, limit: number): string {
  const cut = text.slice(0, limit);
  // Do not leave half a supplementary Unicode character at the excerpt boundary.
  return /[\uD800-\uDBFF]$/u.test(cut) ? cut.slice(0, -1) : cut;
}

function candidate(asset: TeamAsset, bound: boolean, chars: number) {
  const description = excerpt(asset.description, Math.min(800, Math.floor(chars / 2)));
  const content = excerpt(asset.content, chars - description.length);
  return {
    id: asset.id,
    name: asset.name,
    kind: asset.kind,
    available: asset.available,
    description,
    content,
    selection: bound ? ('bound' as const) : ('related' as const),
    excerpted:
      description.length < asset.description.length || content.length < asset.content.length,
  };
}

/** Caller supplies its authorized snapshot. Directory enablement proves no execution permission. */
export function buildPlanningContext(
  state: Workbench,
  task: WorkTask,
  instruction: string,
  baseProposal?: PlanProposal,
) {
  const participants = state.participants
    .filter((p) => task.participantIds.includes(p.id) && p.available)
    .map(({ origin, ...p }) => ({
      ...p,
      ...(origin ? { sourcePackageVersionId: origin.versionId } : {}),
      runtimeAvailability: 'unknown' as const,
      liveWorkload: 'unknown' as const,
    }));
  if (!participants.length)
    throw new WorkbenchError('participants-required', '请先选择至少一位可参与的人或专家。');
  const project = state.projects.find((p) => p.id === task.projectId);
  const currentWorkflows = baseProposal?.result.workflows ?? task.workflows;
  const boundIds = new Set([
    ...currentWorkflows.flatMap((w) => w.nodes.flatMap((n) => [...n.skillIds, ...n.mcpIds])),
    ...participants.flatMap((p) => [
      ...(p.resourceBindings?.skillIds ?? []),
      ...(p.resourceBindings?.mcpIds ?? []),
    ]),
  ]);
  const goalTerms = terms(`${task.title}\n${task.goal}\n${instruction}`);
  const supportingTerms = terms(
    [
      project?.name,
      project?.description,
      ...participants.flatMap((p) => [p.role, ...p.capabilities]),
    ].join('\n'),
  );
  const available = state.assets.filter((a) => a.available);
  const ranked = available
    .map((asset) => ({
      asset,
      bound: boundIds.has(asset.id),
      score:
        16 * overlap(goalTerms, asset.id) +
        8 * overlap(goalTerms, asset.name) +
        4 * overlap(goalTerms, asset.description) +
        2 * overlap(goalTerms, asset.content) +
        overlap(supportingTerms, `${asset.name}\n${asset.description}`),
    }))
    .sort(
      (a, b) =>
        Number(b.bound) - Number(a.bound) ||
        b.score - a.score ||
        (a.asset.id < b.asset.id ? -1 : a.asset.id > b.asset.id ? 1 : 0),
    );
  const bound = ranked.filter((a) => a.bound);
  if (bound.length > PLANNING_BUDGET.assets)
    throw new WorkbenchError(
      'context-limit',
      '当前工作流绑定的资源过多，请拆分工作或减少绑定后再规划。',
    );
  const selected = [
    ...bound,
    ...ranked
      .filter((a) => !a.bound && a.score > 0)
      .slice(0, Math.min(PLANNING_BUDGET.relatedAssets, PLANNING_BUDGET.assets - bound.length)),
  ];
  const context = {
    task: { title: task.title, goal: task.goal, ownerId: task.ownerId },
    project,
    participants,
    assets: selected.map((a) => candidate(a.asset, a.bound, 0)),
    currentWorkflows,
    previousProposal: baseProposal
      ? {
          id: baseProposal.id,
          summary: baseProposal.result.summary,
          questions: baseProposal.result.questions,
          assumptions: baseProposal.result.assumptions,
        }
      : null,
    instruction,
    selection: {
      method: 'local-keyword-v1' as const,
      omittedAssetCount: available.length - selected.length,
      unavailableBindingIds: [...boundIds].filter((id) => !available.some((a) => a.id === id)),
      directoryAvailabilityIsRuntimeReadiness: false,
      executionAuthorization: 'unknown' as const,
      budget: PLANNING_BUDGET,
    },
  };
  // Optional retrieval must not crowd out the user's goal, complete baseline or selected people.
  while (
    JSON.stringify(context).length > PLANNING_BUDGET.contextChars &&
    selected.at(-1)?.bound === false
  ) {
    selected.pop();
    context.assets.pop();
    context.selection.omittedAssetCount++;
  }
  if (JSON.stringify(context).length > PLANNING_BUDGET.contextChars)
    throw new WorkbenchError(
      'context-limit',
      '目标、现有工作流及所选成员资料超过规划预算，请先拆分任务或精简成员说明。',
    );
  // JSON escaping also costs space. Reduce only excerpts until the serialized context fits.
  let textBudget: number = PLANNING_BUDGET.assetTextChars;
  do {
    const perAsset = Math.min(
      PLANNING_BUDGET.assetExcerptChars,
      Math.floor(textBudget / Math.max(1, selected.length)),
    );
    context.assets = selected.map((a) => candidate(a.asset, a.bound, perAsset));
    if (JSON.stringify(context).length <= PLANNING_BUDGET.contextChars) return context;
    textBudget = Math.floor(textBudget / 2);
  } while (textBudget > 0);
  context.assets = selected.map((a) => candidate(a.asset, a.bound, 0));
  return context;
}

export type PlanningContext = ReturnType<typeof buildPlanningContext>;
