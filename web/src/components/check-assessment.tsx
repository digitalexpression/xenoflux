import { useMemo, useRef, useState } from 'react';
import type { CheckAssessmentRow, CheckInspection, Side, VerificationCell } from '@/api/types';
import { StatusBadge } from '@/components/badges';
import { SideText } from '@/components/profile';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';

function statusKind(status: string): 'success' | 'warning' | 'error' | 'neutral' {
  const value = status.trim().toLowerCase().replaceAll('_', '-');
  if (['pass', 'passed', 'success', 'succeeded', 'ok'].includes(value)) return 'success';
  if (['fail', 'failed', 'error'].includes(value)) return 'error';
  if (['skipped', 'partial', 'timeout', 'timed-out', 'blocked', 'not-run'].includes(value)) return 'warning';
  return 'neutral';
}

function humanize(value: string) {
  return value.replaceAll('-', ' ').replaceAll('_', ' ') || 'Not recorded';
}

function definitionLabel(row: CheckAssessmentRow) {
  if (row.definitionMatch === 'same') return 'Same check definition';
  if (row.definitionMatch === 'different') return 'Different check definitions';
  if (row.definitionMatch === 'one-sided') return 'Recorded on one side';
  return 'Definition match unknown';
}

function CheckOutput({ check }: { check: CheckInspection }) {
  const [query, setQuery] = useState('');
  const streams = [
    { name: 'Standard output', text: check.output.stdout },
    { name: 'Standard error', text: check.output.stderr },
  ];
  const matches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return [];
    return streams.flatMap(stream => (stream.text ?? '').split('\n').flatMap((line, index) =>
      line.toLocaleLowerCase().includes(needle) ? [{ stream: stream.name, line, lineNumber: index + 1 }] : []));
  }, [query, check.output.stderr, check.output.stdout]);

  return <section className="check-output" aria-label="Check output">
    <h3 className="text-ui font-semibold">Recorded output</h3>
    {check.output.status === 'omitted' ? <p className="hint" role="note">Output was omitted from this report and is not available in the inspector.</p>
      : check.output.status === 'unavailable' ? <p className="hint" role="note">Output is unavailable in this report.</p>
        : <>
          {check.output.truncated ? <p className="hint" role="note">The retained output was truncated.</p> : null}
          <label className="flex flex-col gap-1 text-ui">Search check output
            <input className="input" type="search" value={query} onChange={event => setQuery(event.target.value)} />
          </label>
          {query.trim() ? <div className="check-output-matches" role="region" aria-label="Matching check output">
            <p role="status" className="hint">{matches.length ? matches.length + ' matching output lines' : 'No output lines match this search.'}</p>
            {matches.slice(0, 100).map((match, index) => <p key={index} className="check-output-match">
              <span className="hint">{match.stream}, line {match.lineNumber}: </span>{match.line}
            </p>)}
            {matches.length > 100 ? <p className="hint">Showing the first 100 matching lines.</p> : null}
          </div> : streams.map(stream => stream.text !== null ? <div key={stream.name} className="flex flex-col gap-1">
            <h4 className="text-ui font-medium">{stream.name}</h4>
            <pre className="check-output-text" aria-label={stream.name}>{stream.text || 'No output recorded.'}</pre>
          </div> : null)}
          {streams.every(stream => stream.text === null) ? <p className="hint">No output text was retained.</p> : null}
        </>}
  </section>;
}

function CheckDetails({ check }: { check: CheckInspection }) {
  return <div className="check-inspector-content flex flex-col gap-4">
    <div className="flex flex-wrap items-center gap-2">
      <StatusBadge status={statusKind(check.status)}>{humanize(check.status)}</StatusBadge>
      <span className="hint">Origin: {humanize(check.origin)}</span>
    </div>
    <dl className="check-inspector-facts">
      <dt>Exit code</dt><dd>{check.exitCode === null ? 'Not recorded' : check.exitCode}</dd>
      <dt>Command</dt><dd>{check.definition.command === null ? 'Not recorded' : <code className="wrap-anywhere">{check.definition.command}</code>}</dd>
      <dt>Purpose</dt><dd>{check.definition.purpose ?? 'Not recorded'}</dd>
      <dt>Timeout</dt><dd>{check.definition.timeoutMs === null ? 'Not recorded' : check.definition.timeoutMs.toLocaleString('en-GB') + ' ms'}</dd>
      <dt>Pass condition</dt><dd>{check.definition.passCondition ?? 'Not recorded'}</dd>
      <dt>Started</dt><dd>{check.execution.startedAt ?? 'Not recorded'}</dd>
      <dt>Elapsed</dt><dd>{check.execution.elapsedMs === null ? 'Not recorded' : check.execution.elapsedMs.toLocaleString('en-GB') + ' ms'}</dd>
      <dt>Task-end workspace baseline</dt><dd>{check.execution.workspaceFingerprint === null ? 'Not recorded' : <code className="wrap-anywhere">{check.execution.workspaceFingerprint}</code>}</dd>
      <dt>Definition fingerprint</dt><dd>{check.definitionFingerprint === null ? 'Not recorded' : <code className="wrap-anywhere">{check.definitionFingerprint}</code>}</dd>
    </dl>
    {check.execution.workspaceFingerprint ? <p className="hint">This is the task-end workspace baseline, not proof that the workspace was unchanged when this check ran.</p> : null}
    {check.detailNote ? <p className="hint" role="note">{check.detailNote}</p> : null}
    <CheckOutput key={check.id} check={check} />
  </div>;
}

export function CheckAssessment({ rows, cells, none, profiles }:
  { rows: CheckAssessmentRow[]; cells: VerificationCell[]; none: boolean; profiles: [string, string] }) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [selectedSide, setSelectedSide] = useState<Side>('a');
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const selected = selectedIndex === null ? null : rows[selectedIndex] ?? null;
  const check = selected?.[selectedSide] ?? null;
  const inspect = (index: number, side: Side, trigger: HTMLButtonElement) => {
    triggerRef.current = trigger;
    setSelectedIndex(index);
    setSelectedSide(side);
    setOpen(true);
  };
  const move = (delta: number) => {
    if (selectedIndex === null || !rows.length) return;
    setSelectedIndex(Math.max(0, Math.min(rows.length - 1, selectedIndex + delta)));
  };
  return <section className="check-assessment flex flex-col gap-3" aria-labelledby="assessment" data-inspecting={open}>
    <h2 id="assessment" className="text-heading">Assessment</h2>
    <p className="hint">Recorded checks and their results. Inspect details without rerunning them.</p>
    {rows.length ? <div className="overflow-x-auto check-assessment-table-wrap">
      <table className="check-assessment-table" aria-label="Recorded checks assessment">
        <thead><tr><th scope="col">Check</th><th scope="col"><SideText side="a">{profiles[0]}</SideText></th><th scope="col"><SideText side="b">{profiles[1]}</SideText></th></tr></thead>
        <tbody>{rows.map((row, index) => <tr key={row.id} data-check-id={row.id}>
          <th scope="row"><span className="check-assessment-name">{row.name}</span><span className="check-assessment-definition">{definitionLabel(row)}</span></th>
          {(['a', 'b'] as const).map((side, sideIndex) => <td key={side} className={side === 'a' ? 'check-assessment-side-a' : 'check-assessment-side-b'}>
            {row[side] ? <div className="check-assessment-result">
              <StatusBadge status={statusKind(row[side]!.status)}>{humanize(row[side]!.status)}</StatusBadge>
              <Button variant="secondary" aria-label={'Inspect ' + profiles[sideIndex] + ' result for ' + row.name}
                onClick={event => inspect(index, side, event.currentTarget)}>Inspect</Button>
            </div> : <span className="hint">No recorded check</span>}
          </td>)}
        </tr>)}</tbody>
      </table>
    </div> : null}
    {rows.length === 0 ? <p className="hint" role="note">{none ? 'No verification checks were selected.' : 'Recorded check details are not available in this report.'}</p> : null}
    {cells.some(cell => (rows.length > 0 && cell.claim) || cell.executionFailures?.length) ? <div className="check-assessment-notes">
      {cells.filter(cell => (rows.length > 0 && cell.claim) || cell.executionFailures?.length).map(cell => <p key={cell.side} className="hint">
        <SideText side={cell.side} className="font-medium">{cell.profile}</SideText>
        {cell.claim ? <> {cell.claim}</> : null}
        {cell.executionFailures?.length ? <> Recorded startup or execution issues: {cell.executionFailures.join('; ')}</> : null}
      </p>)}
    </div> : null}
    <Sheet modal={false} open={open} onOpenChange={setOpen}>
      <SheetContent className="check-inspector" aria-labelledby="check-inspector-title" aria-describedby="check-inspector-description"
        onOpenAutoFocus={event => { event.preventDefault(); requestAnimationFrame(() => titleRef.current?.focus()); }}
        onInteractOutside={event => event.preventDefault()}
        onCloseAutoFocus={event => { event.preventDefault(); if (triggerRef.current?.isConnected) triggerRef.current.focus(); }}>
        <SheetHeader className="check-inspector-header">
          <SheetTitle id="check-inspector-title" tabIndex={-1} ref={titleRef}>Check result inspector</SheetTitle>
          <SheetDescription id="check-inspector-description">Recorded check evidence only. Opening this panel does not rerun the check.</SheetDescription>
        </SheetHeader>
        {selected ? <div className="check-inspector-toolbar">
          <div className="check-inspector-sides" role="group" aria-label="Check result profile">
            {(['a', 'b'] as const).map((side, index) => <Button key={side} variant={selectedSide === side ? 'secondary' : 'ghost-link'}
              aria-pressed={selectedSide === side} aria-label={'Show ' + profiles[index] + ' check details'}
              onClick={() => setSelectedSide(side)}><SideText side={side}>{profiles[index]}</SideText></Button>)}
          </div>
          <div className="check-inspector-nav">
            <Button variant="secondary" onClick={() => move(-1)} disabled={selectedIndex === null || selectedIndex <= 0}>Previous check</Button>
            <span className="hint" aria-live="polite">{selectedIndex === null ? '' : 'Check ' + (selectedIndex + 1) + ' of ' + rows.length}</span>
            <Button variant="secondary" onClick={() => move(1)} disabled={selectedIndex === null || selectedIndex >= rows.length - 1}>Next check</Button>
          </div>
        </div> : null}
        {selected ? <div className="check-inspector-check-title">
          <h3 className="text-body font-semibold">{selected.name}</h3>
          <p className="hint">{definitionLabel(selected)}</p>
        </div> : null}
        {check ? <CheckDetails key={selectedSide + ':' + check.id} check={check} />
          : selected ? <div className="check-inspector-content"><p className="hint">No recorded result for {profiles[selectedSide === 'a' ? 0 : 1]}.</p></div> : null}
      </SheetContent>
    </Sheet>
  </section>;
}
