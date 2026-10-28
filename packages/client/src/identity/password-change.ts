import type { MemberSessionController } from './shell.js';
import type { createIdentityLifecycleApi } from './lifecycle-api.js';

/** A late response cannot sign out a replacement account or clear its form. */
export async function changePasswordAndInvalidate(
  api: Pick<ReturnType<typeof createIdentityLifecycleApi>, 'changePassword'>,
  input: { oldPassword: string; newPassword: string },
  signal: AbortSignal,
  controller: Pick<MemberSessionController, 'getSnapshot' | 'invalidate'>,
  expected: { accountId: string; epoch: number },
  clearInputs: () => void,
): Promise<boolean> {
  await api.changePassword(input, signal);
  signal.throwIfAborted();
  const current = controller.getSnapshot();
  if (
    current.status !== 'authenticated' ||
    current.epoch !== expected.epoch ||
    current.session.accountId !== expected.accountId
  )
    return false;
  clearInputs();
  // The server already revoked old sessions. A late cookie-expiring response
  // or logout request could instead clear a replacement account's login.
  controller.invalidate(expected.epoch);
  return true;
}
