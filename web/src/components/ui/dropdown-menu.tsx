import * as React from 'react';
import * as Menu from '@radix-ui/react-dropdown-menu';

export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;

/** role="menu" with arrow keys, Home/End and Escape returning focus (Radix). */
export function DropdownMenuContent({ children, ...props }: React.ComponentProps<typeof Menu.Content>) {
  return (
    <Menu.Portal>
      <Menu.Content className="menu" sideOffset={6} align="start" {...props}>{children}</Menu.Content>
    </Menu.Portal>
  );
}

export function DropdownMenuItem({ label, detail, disabledReason, onSelect }:
  { label: string; detail?: string; disabledReason?: string; onSelect?: () => void }) {
  return (
    <Menu.Item className="menu-item" disabled={Boolean(disabledReason)} onSelect={onSelect}>
      <span>{label}</span>
      {detail ? <span className="meta">{detail}</span> : null}
      {disabledReason ? <span className="meta">{disabledReason}</span> : null}
    </Menu.Item>
  );
}
