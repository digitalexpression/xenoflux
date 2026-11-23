import { useMemo } from 'react';
import type { AgentMeasurement, MeasureRow, ReportedUsage, SessionReplay, Side, TokenCounters, WorkflowMeasurement } from '@/api/types';
import { replayNames } from '@/components/session-replay';
import { Disclosure } from '@/components/controls';
import { SideText } from '@/components/profile';

type SideData = {
  side: Side;
  profile: string;
  workflow: WorkflowMeasurement | null;
  agents: AgentMeasurement[];
  replay: SessionReplay | null;
  usage: ReportedUsage | null;
};

const parts = [
  { key: 'input', label: 'Uncached input', className: 'measurement-segment-input' },
  { key: 'cachedInput', label: 'Cached input', className: 'measurement-segment-cached' },
  { key: 'output', label: 'Other output', className: 'measurement-segment-output' },
  { key: 'reasoning', label: 'Reasoning', className: 'measurement-segment-reasoning' },
] as const;

function segmented(counters: TokenCounters) {
  const { input, cachedInput, output, reasoning, total } = counters;
  if ([input, cachedInput, output, reasoning, total].some(value => value === null)) return null;
  const uncached = input! - cachedInput!;
  const otherOutput = output! - reasoning!;
  if (cachedInput! < 0 || reasoning! < 0 || uncached < 0 || otherOutput < 0 || input! + output! !== total!) return null;
  return { input: uncached, cachedInput: cachedInput!, output: otherOutput, reasoning: reasoning!, total: total! };
}

function formatCount(value: number | null) {
  return value === null ? 'Not recorded' : value.toLocaleString('en-GB');
}

function formatDuration(value: number | null) {
  if (value === null) return 'Not recorded';
  const seconds = Math.round(value / 1000);
  return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
}

function CounterBar({ counters, scale, label }: { counters: TokenCounters; scale: number; label: string }) {
  const breakdown = segmented(counters);
  if (!breakdown) return <p className="measurement-bar-missing">Token mix not recorded</p>;
  const ariaLabel = label + ': ' + formatCount(breakdown.total) + ' tokens; ' + parts
    .map(part => part.label.toLowerCase() + ' ' + formatCount(breakdown[part.key])).join(', ') + '.';
  return <div className="measurement-bar-track" role="img" aria-label={ariaLabel}>
    <span className="measurement-bar-fill" style={{ width: (breakdown.total / scale) * 100 + '%' }}>
      {parts.map(part => breakdown[part.key] > 0 ? <span key={part.key} className={'measurement-segment ' + part.className}
        style={{ width: (breakdown[part.key] / breakdown.total) * 100 + '%' }} /> : null)}
    </span>
  </div>;
}

function CounterDetails({ counters, note }: { counters: TokenCounters; note?: string }) {
  return <div className="measurement-details">
    <dl className="measurement-counters">
      <dt>Input tokens</dt><dd>{formatCount(counters.input)}</dd>
      <dt>Cached input <span className="hint">(included in input)</span></dt><dd>{formatCount(counters.cachedInput)}</dd>
      <dt>Output tokens</dt><dd>{formatCount(counters.output)}</dd>
      <dt>Reasoning <span className="hint">(included in output)</span></dt><dd>{formatCount(counters.reasoning)}</dd>
      <dt>Total tokens</dt><dd>{formatCount(counters.total)}</dd>
    </dl>
    {note ? <p className="hint">{note}</p> : null}
  </div>;
}

function MeasurementRow({ title, subtitle, durationMs, counters, scale, note, timingNote, isWorkflow, usageStatus, coverageNote, runnerDurationMs, timeOnly }:
  { title: string; subtitle?: string; durationMs: number | null; counters: TokenCounters; scale: number;
    note?: string; timingNote?: string; isWorkflow?: boolean; usageStatus?: WorkflowMeasurement['usageStatus']; coverageNote?: string; runnerDurationMs?: number | null; timeOnly?: boolean }) {
  const validatedWorkflow = isWorkflow && usageStatus === 'validated';
  const workflowCounterText = usageStatus === 'validated' ? formatCount(counters.total)
    : usageStatus === 'partial' ? counters.total === null ? 'Partial · total not established' : formatCount(counters.total) + ' captured tokens'
      : usageStatus === 'unavailable' ? 'Unavailable' : 'Not validated';
  const totalText = isWorkflow ? workflowCounterText : formatCount(counters.total);
  const showBar = !timeOnly && (!isWorkflow || validatedWorkflow || usageStatus === 'partial');
  const workflowBarNote = usageStatus === 'partial' ? 'Partial workflow mix · total not established'
    : usageStatus === 'unavailable' ? 'Workflow mix unavailable'
      : 'Workflow mix withheld until its accounting is validated';
  return <details className={'measurement-row' + (isWorkflow ? ' measurement-row-workflow' : '')}>
    <summary className="measurement-row-summary">
      <span className="measurement-row-label">
        <span className="measurement-chevron" aria-hidden="true">›</span>
        <span className="measurement-row-name">
          <span className="font-medium">{title}</span>
          {subtitle ? <span className="hint">{subtitle}</span> : null}
        </span>
      </span>
      <span className="measurement-row-values">
        <span className="measurement-time">{formatDuration(durationMs)}</span>
        {!timeOnly ? <span className="measurement-total">{totalText}{(!isWorkflow || validatedWorkflow) && counters.total !== null ? <span className="hint"> tokens</span> : null}
          {isWorkflow && usageStatus === 'partial' ? <span className="measurement-workflow-status">Whole workflow not validated</span> : null}
        </span> : null}
      </span>
      {showBar ? <CounterBar counters={counters} scale={scale}
        label={isWorkflow && usageStatus === 'partial' ? 'Captured workflow sessions only' : title} />
        : !timeOnly ? <p className="measurement-bar-missing">{workflowBarNote}</p> : null}
    </summary>
    <div className="measurement-row-details">
      {showBar ? <CounterDetails counters={counters} note={note} /> : note ? <p className="hint">{note}</p> : null}
      {timingNote ? <p className="hint">{timingNote}</p> : null}
      {coverageNote ? <p className="hint">{coverageNote}</p> : null}
      {runnerDurationMs !== undefined && runnerDurationMs !== null ? <p className="hint">Runner task and capture phase: {formatDuration(runnerDurationMs)}. Includes startup and shutdown; setup and checks are separate.</p> : null}
    </div>
  </details>;
}

function LegacyMeasurements({ rows, side, footer }: { rows: MeasureRow[]; side: Side; footer: string }) {
  if (!rows.length) return null;
  return <Disclosure label="Show runner and main-session measurements" expandedLabel="Hide runner and main-session measurements">
    <div className="measurement-legacy">
      <dl className="measurement-counters">
        {rows.map(row => <FragmentMeasurement key={row.name} row={row} side={side} />)}
      </dl>
      <p className="hint">{footer}</p>
    </div>
  </Disclosure>;
}

function FragmentMeasurement({ row, side }: { row: MeasureRow; side: Side }) {
  return <><dt>{row.name}{row.scope ? <span className="hint"> · {row.scope[side]}</span> : null}</dt>
    <dd>{row[side]}{row.caveat ? <span className="hint"> · {row.caveat}</span> : null}</dd></>;
}

function SideMeasurements({ value, scale, legacyRows, footer, noTask, showPairedUsage }:
  { value: SideData; scale: number; legacyRows: MeasureRow[]; footer: string; noTask: boolean; showPairedUsage: boolean }) {
  const names = useMemo(() => replayNames(value.replay), [value.replay]);
  const root = value.agents.find(agent => agent.role === 'root' || agent.parentId === null);
  const children = value.agents.filter(agent => agent !== root);
  const unknownCounters: TokenCounters = { input: null, cachedInput: null, output: null, reasoning: null, total: null };
  const workflow = value.workflow;
  const submitted = noTask || showPairedUsage ? [] : legacyRows.filter(row => row.basis === 'provider-submission' && row[value.side] !== '—');
  const scopeHasUsage = Boolean(value.usage) || submitted.length > 0;
  const rootOnlyTime = scopeHasUsage && root !== undefined && Object.values(root.counters).every(counter => counter === null);
  return <section className="measurement-side" aria-label={value.profile + ' time and tokens'} style={{ borderTopColor: 'var(--color-side-' + value.side + ')' }}>
    <SideText side={value.side} className="measurement-side-title">{value.profile}</SideText>
    {noTask ? <p className="hint">The model task did not start, so session token measurements are unavailable.</p> : null}
    <MeasurementRow title="Workflow" subtitle="Observed session span" durationMs={workflow?.durationMs ?? null}
      counters={workflow?.counters ?? unknownCounters} usageStatus={noTask ? 'unavailable' : workflow?.usageStatus ?? 'unvalidated'}
      scale={scale} isWorkflow note={noTask ? 'No model task started, so workflow token usage is unavailable.'
        : workflow?.usageNote ?? 'The accounting contract for a complete workflow total has not been validated.'}
      timingNote={workflow?.timingNote} coverageNote={workflow?.coverageNote} runnerDurationMs={workflow?.runnerDurationMs} />
    {root ? <MeasurementRow title="Main session" durationMs={root.durationMs} counters={root.counters} scale={scale}
      note={rootOnlyTime ? undefined : root.usageNote} timingNote={root.timingNote} timeOnly={rootOnlyTime} />
      : <MeasurementRow title="Main session" durationMs={null} counters={unknownCounters} scale={scale}
        note="Main session measurements were not recorded." />}
    {submitted.length ? <details className="measurement-row">
      <summary className="measurement-row-summary">
        <span className="measurement-row-label"><span className="measurement-chevron" aria-hidden="true">›</span>
          <span className="font-medium">{submitted[0]?.scope?.[value.side] ?? 'Task submission'}</span></span>
        <span className="hint">Reported token counts</span>
      </summary>
      <div className="measurement-row-details"><dl className="measurement-counters">
        {submitted.map(row => <FragmentMeasurement key={row.name} row={{ ...row, scope: undefined }} side={value.side} />)}
      </dl></div>
    </details> : null}
    {children.map(agent => <MeasurementRow key={agent.id}
      title={names.get(agent.id) ?? agent.name}
      subtitle={'Delegated by ' + (names.get(agent.parentId ?? '') ?? 'an unavailable parent')}
      durationMs={agent.durationMs} counters={agent.counters} scale={scale} note={agent.usageNote} timingNote={agent.timingNote} />)}
    {value.agents.length === 0 && !noTask ? <p className="hint">No per-agent measurements were captured.</p> : null}
    {!value.workflow && value.agents.length === 0 ? <LegacyMeasurements rows={legacyRows.filter(row => row.basis !== 'provider-submission')} side={value.side} footer={footer} /> : null}
  </section>;
}

const reportedFields = [
  ['input', 'Input tokens'], ['uncachedInput', 'Uncached input'], ['cacheRead', 'Cache reads'],
  ['cacheWrite', 'Cache writes'], ['output', 'Output tokens'], ['reasoning', 'Reasoning tokens'], ['total', 'Total tokens'],
] as const satisfies readonly (readonly [keyof ReportedUsage['counters'], string])[];

function ReportedUsageTable({ sides }: { sides: SideData[] }) {
  const rows = reportedFields.filter(([key]) => sides.some(side => side.usage?.counters[key] != null));
  return <section className="panel min-w-0 flex flex-col gap-3" aria-label="Reported usage">
    <div className="overflow-x-auto">
      <table aria-label="Reported token counts" className="w-full table-fixed border-collapse text-ui">
        <thead>
          <tr className="text-left align-top">
            <th scope="col" className="pb-2 pr-2 font-semibold">Token count</th>
            {sides.map(({ side, profile, usage }) => <th key={side} scope="col" className="pb-2 pl-2 wrap-anywhere">
              <SideText side={side}>{profile}</SideText>
              <span className="hint block font-normal">{usage?.scope ?? 'Usage unavailable'}</span>
            </th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map(([key, label]) => <tr key={key} className={key === 'total' ? 'font-semibold' : undefined}>
            <th scope="row" className="border-t py-2 pr-2 text-left font-medium" style={{ borderColor: 'var(--color-divider)' }}>{label}</th>
            {sides.map(({ side, usage }) => {
              const value = usage?.counters[key] ?? null;
              return <td key={side} className="border-t py-2 pl-2 tabular-nums" style={{ borderColor: 'var(--color-divider)' }}>
                {value === null ? <><span aria-hidden="true">—</span><span className="sr-only">Unavailable</span></> : formatCount(value)}
              </td>;
            })}
          </tr>)}
        </tbody>
        <tfoot>
          <tr className="align-top">
            <th scope="row" className="border-t pt-2 pr-2 text-left font-medium" style={{ borderColor: 'var(--color-divider)' }}>Counting method</th>
            {sides.map(({ side, usage }) => <td key={side} className="border-t pt-2 pl-2 hint" style={{ borderColor: 'var(--color-divider)' }}>{usage?.note ?? '—'}</td>)}
          </tr>
        </tfoot>
      </table>
    </div>
    <p className="hint">Each column uses the scope named under its profile. Cross-vendor token deltas have no shared accounting basis.</p>
  </section>;
}

export function WorkflowMeasurements({ profiles, workflow, agents, replay, reportedUsage, timeRows, footer, noTask = false }:
  { profiles: [string, string]; workflow?: { a: WorkflowMeasurement; b: WorkflowMeasurement };
    agents?: { a: AgentMeasurement[]; b: AgentMeasurement[] }; replay?: { a: SessionReplay | null; b: SessionReplay | null } | null;
    reportedUsage?: Record<Side, ReportedUsage | null>; timeRows: MeasureRow[]; footer: string; noTask?: boolean }) {
  const sides: SideData[] = ([['a', 0], ['b', 1]] as const).map(([side, index]) => ({
    side, profile: profiles[index], workflow: workflow?.[side] ?? null,
    agents: noTask ? [] : agents?.[side] ?? [], replay: replay?.[side] ?? null,
    usage: noTask ? null : reportedUsage?.[side] ?? null,
  }));
  const totals = sides.flatMap(value => [
    ...(value.workflow?.usageStatus === 'validated' || value.workflow?.usageStatus === 'partial' ? [value.workflow.counters.total] : []),
    ...value.agents.map(agent => agent.counters.total),
  ].filter((total): total is number => total !== null));
  const scale = Math.max(1, ...totals);
  const showPairedUsage = sides.some(side => side.usage !== null);
  const details = <div className="measurement-section">
    <div className="measurement-legend" role="list" aria-label="Token bar legend">
      {parts.map(part => <span className="measurement-legend-item" role="listitem" key={part.key}>
        <span className={'measurement-swatch ' + part.className} aria-hidden="true" />{part.label}
      </span>)}
    </div>
    <p className="hint">Every bar uses the same scale. The bars include cached input in input and reasoning in output. Expand a row for exact counters and scope.</p>
    {sides.some(value => value.workflow?.usageStatus === 'partial') ? <p className="hint">A partial workflow bar covers captured sessions only; missing sessions remain unknown.</p> : null}
    <div className="report-sides measurement-sides">
      {sides.map(value => <SideMeasurements key={value.side} value={value} scale={scale}
        legacyRows={timeRows} footer={footer} noTask={noTask} showPairedUsage={showPairedUsage} />)}
    </div>
  </div>;
  return showPairedUsage ? <div className="measurement-section">
    <ReportedUsageTable sides={sides} />
    <Disclosure label="Workflow and per-session details" expandedLabel="Hide workflow and per-session details">{details}</Disclosure>
  </div> : details;
}
