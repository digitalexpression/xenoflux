import { Info } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** Cobalt-tinted notice for evidence limits and consequential choices; never success. */
export function InfoNotice({ title, children, action, className, as = 'div', headingLevel }:
  { title?: ReactNode; children?: ReactNode; action?: ReactNode; className?: string; as?: 'div' | 'section'; headingLevel?: 2 | 3 }) {
  const Tag = as;
  const Heading = headingLevel === 2 ? 'h2' : headingLevel === 3 ? 'h3' : 'strong';
  return (
    <Tag className={cn('notice flex gap-3 items-start', className)}>
      <Info size={18} className="mt-0.5 flex-none" style={{ color: 'var(--color-link-focus)' }} aria-hidden="true" />
      <div className="flex flex-col gap-2 min-w-0 flex-1">
        {title ? <Heading className={cn('font-semibold', headingLevel === 2 ? 'text-heading' : 'text-body')}>{title}</Heading> : null}
        {children ? <div className="text-ui flex flex-col gap-2">{children}</div> : null}
        {action ? <div className="flex flex-wrap gap-2">{action}</div> : null}
      </div>
    </Tag>
  );
}

/** Warning panel; role="alert" only when it appears in response to an action. */
export function WarningAlert({ title, children, actions, live = false }:
  { title: ReactNode; children?: ReactNode; actions?: ReactNode; live?: boolean }) {
  return (
    <div className="alert-warning flex flex-col gap-2" role={live ? 'alert' : undefined}>
      <strong className="font-semibold">{title}</strong>
      {children ? <div className="text-ui">{children}</div> : null}
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function ErrorPanel({ title, children, actions, live = true }: { title: ReactNode; children?: ReactNode; actions?: ReactNode; live?: boolean }) {
  return (
    <div className="alert-error flex flex-col gap-2" role={live ? 'alert' : undefined}>
      <strong className="font-semibold">{title}</strong>
      {children ? <div className="text-ui">{children}</div> : null}
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

/** Labels screens that show synthetic data or simulated operations (U0 prototype). */
export function SimulatedNote({ children }: { children?: ReactNode }) {
  return (
    <p className="hint" data-simulated="true">
      <strong className="font-semibold">Demo data.</strong> {children ?? 'This screen uses synthetic examples; nothing on this Mac is read or changed.'}
    </p>
  );
}
