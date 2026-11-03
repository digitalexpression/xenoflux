import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

/** Modal dialog: traps focus and restores it on close (Radix). */
export function DialogContent({ className, children, title, description, onOpenAutoFocus, onCloseAutoFocus, ...props }:
  React.ComponentProps<typeof DialogPrimitive.Content> & { title: string; description?: React.ReactNode }) {
  const opener = React.useRef<HTMLElement | null>(null);
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="dialog-overlay" />
      <DialogPrimitive.Content className={cn('dialog flex flex-col gap-4', className)} {...props}
        onOpenAutoFocus={event => { opener.current = document.activeElement as HTMLElement; onOpenAutoFocus?.(event); }}
        onCloseAutoFocus={event => {
          onCloseAutoFocus?.(event);
          if (!event.defaultPrevented && opener.current?.isConnected) {
            event.preventDefault();
            opener.current.focus();
          }
        }}
        {...(description ? {} : { 'aria-describedby': undefined })}>
        <div className="flex items-start justify-between gap-4">
          <DialogPrimitive.Title className="text-heading">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Close className="btn btn-icon" aria-label="Close">
            <X size={18} aria-hidden="true" />
          </DialogPrimitive.Close>
        </div>
        {description ? <DialogPrimitive.Description className="text-body">{description}</DialogPrimitive.Description> : null}
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
