import { useId } from 'react';
import type { ComparisonLabel, Report, SessionControlsComparison as Controls, Side } from '@/api/types';
import { ComparisonBadge } from '@/components/badges';
import { Disclosure } from '@/components/controls';
import { InfoNotice } from '@/components/notices';
import { SideText } from '@/components/profile';
import { SessionHarness } from '@/components/session-harness';
import { cn } from '@/lib/cn';

const comparisonLabels = {
  same: 'same', different: 'different', unknown: 'cannot-compare', 'not-comparable': 'cannot-compare',
} satisfies Record<Controls['rows'][number]['status'], ComparisonLabel>;
const groupLabels = { model: 'Model settings', harness: 'Harness settings', inputs: 'Task inputs' };
const stageLabels = { requested: 'Requested', sent: 'Sent', confirmed: 'Confirmed', observed: 'Response reported' };

export function SessionControlsComparison({ controls, harness, profiles, onOpenCompaction }: {
  controls: Report['sessionControls'];
  harness: Report['sessionHarness'];
  profiles: Record<Side, string>;
  onOpenCompaction: (side: Side, sessionId: string, eventId: string) => void;
}) {
  const id = useId();
  return <section className="flex flex-col gap-3" aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`} className="text-heading">Session and harness comparison</h2>
    {controls ? <>
      <div className="report-sides">
        <div className="panel flex flex-col gap-2">
          <p className="meta">Requested variation</p>
          <p className="text-body font-semibold">{controls.requested.label}</p>
          <p className="text-ui">{controls.requested.text}</p>
        </div>
        <div className="panel flex flex-col gap-2">
          <p className="meta">Recorded evidence</p>
          <p className="text-body font-semibold">{controls.recorded.label}</p>
          <p className="text-ui">{controls.recorded.text}</p>
        </div>
      </div>
    </> : <p className="hint">Requested variation and recorded control comparisons are unavailable in this report.</p>}
    <InfoNotice title="Historical equivalence is not established">
      <p>Matching source labels or recorded settings do not prove equal effective context. Today’s setup cannot fill historical gaps. Each side keeps its own turn order and source references.</p>
      {controls?.limits.length ? <Disclosure label="Comparison reading limits" expandedLabel="Hide comparison reading limits"><ul className="list-disc pl-5">{controls.limits.map(limit => <li key={limit}>{limit}</li>)}</ul></Disclosure> : null}
    </InfoNotice>
    {controls ? <Disclosure label={`Inspect recorded controls (${controls.rows.length})`} expandedLabel="Hide recorded controls">
      {controls.rows.length ? <div className="report-pairs" role="table" aria-label="Recorded session controls comparison">
        <div className="report-pair-heading" role="row">
          <span role="columnheader">Control and observation</span>
          {(['a', 'b'] as const).map(side => <span key={side} role="columnheader"><SideText side={side}>{side === 'a' ? 'Left' : 'Right'} · {profiles[side]}</SideText></span>)}
        </div>
        {controls.rows.map(row => <div key={row.id} className="report-pair-row" role="row">
          <div role="rowheader" className="report-pair-label">
            <span className={cn('text-ui', row.status === 'different' ? 'font-semibold' : 'muted')}>{row.name}</span>
            <p className="meta">{groupLabels[row.group]}{row.stage ? ` · ${stageLabels[row.stage]}` : ''}</p>
            <ComparisonBadge label={comparisonLabels[row.status]} reason={row.note} />
            {row.status === 'unknown' || row.status === 'not-comparable' ? <p className="meta">Recorded state · {row.status}</p> : null}
          </div>
          {(['a', 'b'] as const).map(side => <div key={side} role="cell" className={cn('report-pair-value', side === 'a' ? 'report-pair-a' : 'report-pair-b')}>
            <span className="report-mobile-label">{side === 'a' ? 'Left' : 'Right'} · {profiles[side]}</span>
            {row.status === 'different' ? <SideText side={side}>{row[side]}</SideText> : <span className="muted wrap-anywhere">{row[side]}</span>}
          </div>)}
        </div>)}
      </div> : <p className="text-ui">No comparable control observations were retained.</p>}
    </Disclosure> : null}
    {harness ? <Disclosure label="Inspect each session’s harness evidence" expandedLabel="Hide session harness evidence">
      <div className="report-sides">
        {(['a', 'b'] as const).map(side => <div key={side} className="min-w-0 flex flex-col gap-3">
          <p className="text-body"><SideText side={side}>{side === 'a' ? 'Left' : 'Right'} · {profiles[side]}</SideText></p>
          <p className="meta">{harness[side].mode}</p>
          <dl className="flex flex-wrap gap-x-4 gap-y-2 text-ui">{harness[side].coverage.map(row => <div key={row.name}><dt className="font-medium">{row.name}</dt><dd>{row.state}{row.note ? <p className="hint">{row.note}</p> : null}</dd></div>)}</dl>
          <SessionHarness data={harness[side]} headingLevel={3} sectionId={`${id}-${side}-harness`} titleId={`${id}-${side}-harness-title`}
            onOpenCompaction={(sessionId, eventId) => onOpenCompaction(side, sessionId, eventId)} />
        </div>)}
      </div>
    </Disclosure> : null}
  </section>;
}
