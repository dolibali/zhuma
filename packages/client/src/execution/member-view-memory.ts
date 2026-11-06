import type { InboxItem, Workbench } from '@zhuma/agent-core';
import type { ExecutionNodeWire, InboxPlaceWire, StartablePlanWire } from './ExecutionApi.js';

/** Presentation only. It never authorizes a member, a space, or a later command. */
export interface MemberViewScope {
  readonly accountId: string;
  readonly spaceId: string;
}
export interface MemberWorkbenchPaint {
  readonly state: Workbench;
  readonly model: string;
}
export interface MemberInboxPaint {
  readonly items: readonly InboxItem[];
  readonly nodes: readonly ExecutionNodeWire[];
  readonly places?: readonly InboxPlaceWire[];
}

interface Slot extends MemberViewScope {
  workbench?: MemberWorkbenchPaint;
  plans?: readonly StartablePlanWire[];
  inbox?: MemberInboxPaint;
}

const limit = 4;
const slots: Slot[] = [];

function remember(accountId: string, spaceId: string): Slot | undefined {
  if (!accountId || !spaceId) return undefined;
  for (let index = slots.length - 1; index >= 0; index -= 1)
    if (slots[index]!.accountId !== accountId) slots.splice(index, 1);
  const found = slots.findIndex((item) => item.accountId === accountId && item.spaceId === spaceId);
  const slot = found === -1 ? { accountId, spaceId } : slots.splice(found, 1)[0]!;
  slots.push(slot);
  while (slots.length > limit) slots.shift();
  return slot;
}
function recall(accountId: string, spaceId: string): Slot | undefined {
  return slots.find((item) => item.accountId === accountId && item.spaceId === spaceId);
}

export function recallMemberWorkbench(
  accountId: string,
  spaceId: string,
): MemberWorkbenchPaint | undefined {
  return recall(accountId, spaceId)?.workbench;
}
export function rememberMemberWorkbench(
  accountId: string,
  spaceId: string,
  paint: MemberWorkbenchPaint,
): void {
  const slot = remember(accountId, spaceId);
  if (slot) slot.workbench = paint;
}
export function recallMemberPlans(
  accountId: string,
  spaceId: string,
): readonly StartablePlanWire[] | undefined {
  return recall(accountId, spaceId)?.plans;
}
export function rememberMemberPlans(
  accountId: string,
  spaceId: string,
  plans: readonly StartablePlanWire[],
): void {
  const slot = remember(accountId, spaceId);
  if (slot) slot.plans = plans;
}
export function recallMemberInbox(
  accountId: string,
  spaceId: string,
): MemberInboxPaint | undefined {
  return recall(accountId, spaceId)?.inbox;
}
export function rememberMemberInbox(
  accountId: string,
  spaceId: string,
  paint: MemberInboxPaint,
): void {
  const slot = remember(accountId, spaceId);
  if (slot) slot.inbox = paint;
}
/** Sign-out removes every remembered read. A later account must not paint the previous one. */
export function forgetMemberViews(): void {
  slots.length = 0;
}
