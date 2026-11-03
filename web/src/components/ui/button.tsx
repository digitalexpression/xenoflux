import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

// DESIGN.md › Interaction States; the styles live in app.css so hover,
// pressed, disabled and busy treatments stay token-driven.
const buttonVariants = cva('btn', {
  variants: {
    variant: {
      primary: 'btn-primary',
      secondary: '',
      destructive: 'btn-destructive',
      'destructive-outline': 'btn-destructive-outline',
      'ghost-link': 'btn-link',
      replay: 'btn-replay',
    },
    size: { default: '', icon: 'btn-icon' },
  },
  defaultVariants: { variant: 'secondary', size: 'default' },
});

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /** Busy keeps the width and shows a named label, and blocks activation. */
  busy?: boolean;
  busyLabel?: string;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, busy = false, busyLabel, children, disabled, type, ...props }, ref) => {
    const Component = asChild ? Slot : 'button';
    return (
      <Component
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        disabled={asChild ? undefined : disabled || busy}
        aria-busy={busy || undefined}
        {...(asChild ? {} : { type: type ?? 'button' })}
        {...props}
      >
        {!asChild && busyLabel ? (
          // Both labels occupy one grid cell, reserving the larger label's
          // width before a request starts. Only the active label is exposed.
          <span className="btn-label">
            <span style={{ visibility: busy ? 'hidden' : undefined }} aria-hidden={busy || undefined}>{children}</span>
            <span style={{ visibility: busy ? undefined : 'hidden' }} aria-hidden={!busy || undefined}>{busyLabel}</span>
          </span>
        ) : busy && busyLabel ? busyLabel : children}
      </Component>
    );
  },
);
Button.displayName = 'Button';

/** A disabled action with its reason as adjacent readable text, not a tooltip. */
export function DisabledReason({ id, children }: { id: string; children: React.ReactNode }) {
  return <span id={id} className="hint">{children}</span>;
}
