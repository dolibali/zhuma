import { useSyncExternalStore } from 'react';
import { SingleSelect } from './SingleSelect.js';

export type AppearancePreference = 'light' | 'dark' | 'system';
export interface AppearanceStore {
  getSnapshot(): string;
  subscribe(listener: () => void): () => void;
  set(preference: AppearancePreference): void;
}

/** The official host owns this preference, persistence and OS theme resolution. */
export function Appearance({ store }: { store: AppearanceStore }) {
  const preference = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const caption = { light: '浅色', dark: '深色', system: '跟随系统' }[preference];
  return (
    <SingleSelect
      className="zm-appearance"
      label="外观"
      popupMinWidth={144}
      title={`外观：${caption}`}
      triggerContent={
        <svg
          aria-hidden="true"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {preference === 'system' ? (
            <>
              <rect x="3" y="4" width="18" height="13" rx="2" />
              <path d="M8 21h8m-4-4v4" />
            </>
          ) : preference === 'dark' ? (
            <path d="M20.8 14a9 9 0 0 1-10.8-10.8A9 9 0 1 0 20.8 14Z" />
          ) : (
            <>
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
            </>
          )}
        </svg>
      }
      value={preference}
      onValueChange={(value) => store.set(value as AppearancePreference)}
      options={[
        { value: 'system', label: '跟随系统' },
        { value: 'light', label: '浅色' },
        { value: 'dark', label: '深色' },
      ]}
    />
  );
}
