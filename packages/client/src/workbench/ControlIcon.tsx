/** Fixed icon box shared by select, disclosure and navigation controls. */
export function ControlIcon({ direction }: { direction: 'down' | 'left' | 'right' | 'up' }) {
  const rotation = { down: 0, left: 90, up: 180, right: 270 }[direction];
  return (
    <span className="zm-control-icon" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path
          d="m3.5 6 4.5 4 4.5-4"
          transform={`rotate(${rotation} 8 8)`}
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

export function SettingsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path
        d="M7.45 1.75h3.1l.35 1.67c.39.13.76.29 1.11.48l1.47-.87 2.19 2.19-.87 1.47c.19.35.35.72.48 1.11l1.67.35v3.1l-1.67.35c-.13.39-.29.76-.48 1.11l.87 1.47-2.19 2.19-1.47-.87c-.35.19-.72.35-1.11.48l-.35 1.67h-3.1l-.35-1.67c-.39-.13-.76-.29-1.11-.48l-1.47.87-2.19-2.19.87-1.47c-.19-.35-.35-.72-.48-1.11l-1.67-.35v-3.1l1.67-.35c.13-.39.29-.76.48-1.11l-.87-1.47 2.19-2.19 1.47.87c.35-.19.72-.35 1.11-.48l.35-1.67Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="9" cy="9.3" r="2.3" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}
/** Selected choice uses the same bounded stroke icon system as menu/navigation controls. */
export function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="m3.5 8 3 3 6-6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Folder outline used as the project-directory leading mark. */
export function ProjectIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  );
}
