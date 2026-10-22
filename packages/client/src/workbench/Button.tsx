import type { ButtonHTMLAttributes, ReactNode } from 'react';

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
        <span className="zm-spinner" aria-hidden />
        {busyLabel}
      </span>
    </button>
  );
}
