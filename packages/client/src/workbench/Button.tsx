import type { ButtonHTMLAttributes, ReactNode, SVGAttributes } from 'react';

/** Circular arc. A square SVG viewport stays round if a flex parent stretches the slot. */
export function Spinner(props: SVGAttributes<SVGSVGElement>) {
  return (
    <span className="zm-spinner" aria-hidden="true">
      <svg
        viewBox="0 0 16 16"
        width="14"
        height="14"
        focusable="false"
        aria-hidden="true"
        {...props}
      >
        <circle
          cx="8"
          cy="8"
          r="5.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeDasharray="22 13"
        />
      </svg>
    </span>
  );
}

/** Client-only action primitive; the workbench plugin installs its shared theme styles. */
export function Button({
  variant = 'secondary',
  busy = false,
  busyLabel = '处理中…',
  children,
  className = '',
  disabled,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
  busy?: boolean;
  busyLabel?: string;
  children: ReactNode;
}) {
  return (
    <button
      {...props}
      type={type}
      className={`zm-button ${variant === 'quiet' ? 'zm-quiet' : variant} ${className}`}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    >
      <span className="zm-button-label" aria-hidden={busy || undefined}>
        {children}
      </span>
      <span className="zm-button-busy" aria-hidden={!busy}>
        <Spinner />
        {busyLabel}
      </span>
    </button>
  );
}
