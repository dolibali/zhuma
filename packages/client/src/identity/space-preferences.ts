/** A space ID is only a UI preference. It never grants access or caches work. */
export interface SpacePreferenceStore {
  read(accountId: string): string | undefined;
  save(accountId: string, spaceId: string): void;
  clearIfMatches(accountId: string, spaceId: string): void;
}

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const keyFor = (accountId: string) => `zhuma:member-space:v1:${encodeURIComponent(accountId)}`;

/** Browser storage may be disabled; losing this preference must never block login. */
export function createSpacePreferenceStore(
  storage: () => PreferenceStorage | undefined = () => globalThis.localStorage,
): SpacePreferenceStore {
  function read(accountId: string): string | undefined {
    try {
      const value = storage()?.getItem(keyFor(accountId));
      return value || undefined;
    } catch {
      return undefined;
    }
  }
  return {
    read,
    save(accountId, spaceId) {
      try {
        storage()?.setItem(keyFor(accountId), spaceId);
      } catch {
        // The selected space remains usable for this session without persistence.
      }
    },
    clearIfMatches(accountId, spaceId) {
      try {
        const available = storage();
        if (available?.getItem(keyFor(accountId)) === spaceId)
          available.removeItem(keyFor(accountId));
      } catch {
        // An unavailable preference store has no effect on trusted directory facts.
      }
    },
  };
}
