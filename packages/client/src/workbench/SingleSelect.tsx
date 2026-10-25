import { useRef, useState, type ReactNode } from 'react';
import { Select } from '@base-ui/react/select';
import { Combobox } from '@base-ui/react/combobox';
import { ControlIcon } from './ControlIcon.js';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}
export interface SingleSelectProps {
  id?: string;
  label: string;
  title?: string;
  className?: string;
  value: string;
  options: SelectOption[];
  disabled?: boolean;
  triggerContent?: ReactNode;
  onValueChange(value: string): void;
}

/** One anchored single-choice surface; Base UI owns positioning and keyboard/focus behavior. */
export function SingleSelect({
  id,
  label,
  title,
  className = '',
  value,
  options,
  disabled,
  triggerContent,
  onValueChange,
}: SingleSelectProps) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const closeReason = useRef('');
  const searchable = options.length > 8;
  const finalFocus = () => closeReason.current !== 'focus-out';
  const caption = options.find((option) => option.value === value)?.label ?? '请选择';
  const triggerProps = {
    id,
    ref: trigger,
    'aria-label': label,
    title: title ?? caption,
    className: `zm-single-select ${className}`,
  };
  const positioning = {
    side: 'bottom' as const,
    align: 'start' as const,
    sideOffset: 5,
    collisionPadding: 8,
    positionMethod: 'fixed' as const,
    className: 'zm-select-positioner',
  };
  // A body portal is inert and below a native modal dialog. Keep it in the active dialog instead.
  const preparePortal = (
    open: boolean,
    details: { reason: string; event: { preventDefault(): void } },
  ) => {
    // Consume native Escape so only this menu closes, not its enclosing dialog.
    if (details.reason === 'escape-key') details.event.preventDefault();
    closeReason.current = details.reason;
    setOpen(open);
    if (open) setContainer(trigger.current?.closest('dialog') ?? document.body);
  };
  const content = triggerContent ?? (
    <>
      <span className="zm-select-value">{caption}</span>
      <ControlIcon direction="down" />
    </>
  );
  if (searchable) {
    return (
      <Combobox.Root
        open={open}
        items={options}
        value={options.find((option) => option.value === value) ?? null}
        isItemEqualToValue={(a, b) => a.value === b.value}
        disabled={disabled}
        onValueChange={(option) => {
          if (option) onValueChange(option.value);
        }}
        onOpenChange={preparePortal}
      >
        <Combobox.Trigger {...triggerProps}>{content}</Combobox.Trigger>
        <Combobox.Portal container={container}>
          <Combobox.Positioner {...positioning}>
            <Combobox.Popup className="zm-select-popup" finalFocus={finalFocus}>
              <Combobox.Input
                className="zm-select-search"
                aria-label={`搜索${label}`}
                placeholder="搜索…"
              />
              <Combobox.Empty className="zm-select-empty">没有匹配选项</Combobox.Empty>
              <Combobox.List className="zm-select-list">
                {(option: SelectOption) => (
                  <Combobox.Item
                    key={option.value}
                    value={option}
                    disabled={option.disabled}
                    className="zm-select-option"
                  >
                    <Combobox.ItemIndicator className="zm-select-check">✓</Combobox.ItemIndicator>
                    <span>{option.label}</span>
                  </Combobox.Item>
                )}
              </Combobox.List>
            </Combobox.Popup>
          </Combobox.Positioner>
        </Combobox.Portal>
      </Combobox.Root>
    );
  }
  return (
    <Select.Root
      open={open}
      value={value}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next);
      }}
      disabled={disabled}
      modal={false}
      onOpenChange={preparePortal}
    >
      <Select.Trigger {...triggerProps}>{content}</Select.Trigger>
      <Select.Portal container={container}>
        <Select.Positioner {...positioning} alignItemWithTrigger={false}>
          <Select.Popup className="zm-select-popup" finalFocus={finalFocus}>
            <Select.List className="zm-select-list">
              {options.map((option) => (
                <Select.Item
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                  className="zm-select-option"
                >
                  <Select.ItemIndicator className="zm-select-check">✓</Select.ItemIndicator>
                  <Select.ItemText>{option.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.List>
            {!options.length && <div className="zm-select-empty">暂无可选项</div>}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}
