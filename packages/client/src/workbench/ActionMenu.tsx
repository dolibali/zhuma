import { useRef, useState, type CSSProperties } from 'react';
import { Menu } from '@base-ui/react/menu';
import { ControlIcon } from './ControlIcon.js';

/** Small action menus share the existing anchored surface; Base UI owns keyboard and focus. */
export function ActionMenu({
  label,
  items,
  busy = false,
  busyLabel = '处理中…',
}: {
  label: string;
  items: readonly {
    label: string;
    disabled?: boolean;
    onSelect(trigger: HTMLButtonElement): void;
  }[];
  busy?: boolean;
  busyLabel?: string;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [font, setFont] = useState<CSSProperties>();
  const closeReason = useRef('');
  const pending = useRef<((trigger: HTMLButtonElement) => void) | undefined>();
  return (
    <Menu.Root
      modal={false}
      onOpenChange={(open, details) => {
        if (details.reason === 'escape-key') details.event.preventDefault();
        closeReason.current = details.reason;
        if (open) {
          setContainer(trigger.current?.closest('dialog') ?? document.body);
          if (trigger.current) {
            const style = window.getComputedStyle(trigger.current);
            setFont({
              fontFamily: style.fontFamily,
              fontSize: style.fontSize,
              fontWeight: style.fontWeight,
              lineHeight: style.lineHeight,
            });
          }
        }
      }}
      onOpenChangeComplete={(open) => {
        if (open) return;
        // Close the menu before an action opens a modal or begins downloading.
        const action = pending.current;
        pending.current = undefined;
        if (trigger.current) action?.(trigger.current);
      }}
    >
      <Menu.Trigger
        ref={trigger}
        className="zm-button secondary zm-action-menu-trigger"
        aria-label={label}
        aria-busy={busy || undefined}
      >
        <span>{busy ? busyLabel : label}</span>
        <ControlIcon direction="down" />
      </Menu.Trigger>
      <Menu.Portal container={container}>
        <Menu.Positioner
          side="bottom"
          align="end"
          sideOffset={4}
          collisionPadding={8}
          positionMethod="fixed"
          className="zm-select-positioner"
          style={{ ...font, '--zm-select-min-width': '156px' } as CSSProperties}
        >
          <Menu.Popup
            className="zm-select-popup zm-action-menu-popup"
            finalFocus={() => closeReason.current !== 'focus-out'}
          >
            {items.map((item) => (
              <Menu.Item
                key={item.label}
                className="zm-select-option zm-action-menu-item"
                disabled={busy || item.disabled}
                onClick={() => {
                  pending.current = item.onSelect;
                }}
              >
                {item.label}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
