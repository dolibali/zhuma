import {
  WorkNodeSchema,
  type Participant,
  type PlanProposal,
  type PlanningAdjustment,
  type TeamAsset,
  type WorkNode,
  type WorkTask,
} from '@zhuma/agent-core';

type Selection = Pick<WorkNode, 'assigneeId' | 'skillIds' | 'mcpIds'>;

export function expertResources(
  node: Selection,
  members: readonly Participant[],
  assets: readonly TeamAsset[],
) {
  const expert = members.find(
    (member) => member.id === node.assigneeId && member.kind === 'expert',
  );
  return (['skill', 'mcp'] as const).flatMap((kind) => {
    const field = kind === 'skill' ? 'skillIds' : 'mcpIds';
    return [...new Set(expert?.resourceBindings?.[field] ?? [])].map((id) => {
      const asset = assets.find((asset) => asset.id === id && asset.kind === kind);
      return {
        id,
        kind,
        name: asset?.name ?? (kind === 'skill' ? '不可用 Skill' : '不可用 MCP'),
        available: asset?.available === true,
        selected: node[field].includes(id),
      };
    });
  });
}

// Call only for an explicit executor choice or a newly received planning preview.
// Never infer ownership of existing choices, or re-add a user's removal on render/save.
export function selectExpertResources(
  node: Selection,
  members: readonly Participant[],
  assets: readonly TeamAsset[],
): Pick<WorkNode, 'skillIds' | 'mcpIds'> {
  const selected = { skillIds: [...node.skillIds], mcpIds: [...node.mcpIds] };
  if (!members.some((member) => member.id === node.assigneeId && member.available)) return selected;
  for (const resource of expertResources(node, members, assets)) {
    if (!resource.available || resource.selected) continue;
    const field = resource.kind === 'skill' ? 'skillIds' : 'mcpIds';
    const next = [...selected[field], resource.id];
    // Preserve explicit choices rather than evicting them to fit the existing schema limit.
    if (WorkNodeSchema.shape[field].safeParse(next).success) selected[field] = next;
  }
  return selected;
}

export function prepareExpertProposal(
  proposal: PlanProposal,
  task: WorkTask,
  members: readonly Participant[],
  assets: readonly TeamAsset[],
  adjustment?: PlanningAdjustment,
): PlanProposal {
  if (task.status !== 'draft') return proposal;
  const participants = members.filter((member) => task.participantIds.includes(member.id));
  return {
    ...proposal,
    result: {
      ...proposal.result,
      workflows: proposal.result.workflows.map((workflow) => ({
        ...workflow,
        nodes: workflow.nodes.map((node) => {
          if (adjustment && node.id !== adjustment.nodeId) return node;
          const skillsAllowed = !adjustment || adjustment.fields.includes('skillIds');
          const mcpAllowed = !adjustment || adjustment.fields.includes('mcpIds');
          if (!skillsAllowed && !mcpAllowed) return node;
          const selected = selectExpertResources(node, participants, assets);
          return {
            ...node,
            ...(skillsAllowed ? { skillIds: selected.skillIds } : {}),
            ...(mcpAllowed ? { mcpIds: selected.mcpIds } : {}),
          };
        }),
      })),
    },
  };
}
