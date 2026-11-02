import type { ComparisonLabel, ExactState, StatusKind } from '@/api/types';

const COMPARISON = {
  different: { className: 'badge badge-different', icon: '≠', text: 'Different' },
  same: { className: 'badge badge-same', icon: '=', text: 'Same' },
  'cannot-compare': { className: 'badge badge-cannot', icon: '?', text: 'Could not compare' },
} as const;

/** Different is the only filled badge; never success/warning/error colours. */
export function ComparisonBadge({ label, reason, exactState }: { label: ComparisonLabel; reason?: string; exactState?: ExactState }) {
  if (label === 'not-applicable') return <NotApplicableLabel />;
  const kind = COMPARISON[label];
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className={kind.className} data-state={exactState}>
        <span aria-hidden="true">{kind.icon}</span>{kind.text}
      </span>
      {reason ? <span className="hint">{reason}</span> : null}
    </span>
  );
}

export function NotApplicableLabel() {
  return <span className="hint">Not applicable</span>;
}

const STATUS_ICON: Record<StatusKind, string> = { success: '✓', warning: '!', error: '✕', neutral: '' };

/** Named checks and operations only. The text always carries the meaning. */
export function StatusBadge({ status, children }: { status: StatusKind; children: React.ReactNode }) {
  return (
    <span className={`badge ${status === 'neutral' ? '' : `badge-${status}`}`}>
      {STATUS_ICON[status] ? <span aria-hidden="true">{STATUS_ICON[status]}</span> : null}
      {children}
    </span>
  );
}

const VERDICT = { positive: 'Positive', negative: 'Negative', mixed: 'Mixed', inconclusive: 'Inconclusive' } as const;

export function VerdictBadge({ verdict }: { verdict: keyof typeof VERDICT }) {
  return <span className="badge">Verdict: {VERDICT[verdict]}</span>;
}

export function TagPill({ children }: { children: React.ReactNode }) {
  return <span className="badge">{children}</span>;
}
