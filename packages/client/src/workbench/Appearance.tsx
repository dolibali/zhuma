import { useSyncExternalStore } from 'react';

export type AppearancePreference = 'light' | 'dark' | 'system';
export interface AppearanceStore {
  getSnapshot(): string;
  subscribe(listener: () => void): () => void;
  set(preference: AppearancePreference): void;
}

/** The official host owns this preference, persistence and OS theme resolution. */
export function Appearance({ store }: { store: AppearanceStore }) {
  const preference = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return (
    <select
      className="zm-appearance"
      aria-label="外观"
      title="外观 · 与应用设置同步"
      value={preference}
      onChange={(event) => store.set(event.target.value as AppearancePreference)}
    >
      <option value="system">跟随系统</option>
      <option value="light">浅色</option>
      <option value="dark">深色</option>
    </select>
  );
}
