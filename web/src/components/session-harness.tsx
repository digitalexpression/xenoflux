import { Link } from 'react-router';
import type { SessionHarnessEvidence, SkillSourceReference } from '@/api/types';
import { Disclosure } from '@/components/controls';
import { Button } from '@/components/ui/button';

function SkillReference({ reference }: { reference: SkillSourceReference }) {
  switch (reference.kind) {
    case 'file-line':
      return <>Source line {reference.line}{reference.itemId ? ` · Item ${reference.itemId}` : ''}{reference.source ? ` · ${reference.source}` : ''}</>;
    case 'structured-selection':
      return <>Structured selection · {reference.source}</>;
    case 'native-telemetry': {
      const producerTime = reference.timestamps.find(time => time.clock === 'producer-reported' || time.clock === 'unattributed');
      const receiptTimes = reference.timestamps.filter(time => time !== producerTime);
      return <>Native telemetry{reference.invocationType ? ` · ${reference.invocationType}` : ''}
        {reference.source ? ` · ${reference.source}` : ''} · Observation {reference.observationId ?? 'ID not retained'}
        {producerTime ? ` · ${producerTime.clock === 'producer-reported' ? 'Producer event' : 'Recorded timestamp'} ${producerTime.iso}` : ''}
        {receiptTimes.length ? <Disclosure label="Telemetry clock details" expandedLabel="Hide telemetry clock details">
          {receiptTimes.map(time => <p key={time.clock}>{time.clock} · {time.source} · {time.iso}</p>)}
          <p>Clock relationship unknown. These timestamps do not establish delivery latency.</p>
        </Disclosure> : null}</>;
    }
    case 'unavailable':
      return <>Source reference unavailable</>;
    default: {
      const exhaustive: never = reference;
      return exhaustive;
    }
  }
}

export function SessionHarness({ data, onOpenCompaction, headingLevel = 2, sectionId = 'session-harness', titleId = 'harness-title' }: {
  data: SessionHarnessEvidence;
  onOpenCompaction: (sessionId: string, eventId: string) => void;
  headingLevel?: 2 | 3;
  sectionId?: string;
  titleId?: string;
}) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const Subheading = headingLevel === 2 ? 'h3' : 'h4';
  const observedSkills = data.skills.filter(skill => skill.observations.length > 0);
  const catalogOnlySkills = data.skills.filter(skill => skill.observations.length === 0);
  return <section id={sectionId} className="flex flex-col gap-3 scroll-mt-4" aria-labelledby={titleId}>
        <Heading id={titleId} className={headingLevel === 2 ? 'text-heading' : 'text-body font-semibold'}>Harness and context</Heading>
        <p className="hint">Requested, sent, confirmed and response-reported settings are separate observations. A skill advertised in a catalog is not proof it was used.</p>
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))' }}>
          {data.settings.map(row => <dl key={row.name} className="panel flex flex-col gap-1 text-ui min-w-0 wrap-anywhere">
            <dt className="font-semibold">{row.name}</dt>
            <dd>Requested: {row.requested ?? 'Not recorded'}</dd><dd>Sent: {row.sent ?? 'Not recorded'}</dd>
            <dd>Confirmed: {row.confirmed ?? 'Not recorded'}</dd><dd>Response reported: {row.observed ?? 'Not recorded'}</dd>
          </dl>)}
        </div>
        <Disclosure label={`Turn setting observations (${data.turns.length})`} expandedLabel="Hide turn settings">
          <p className="hint">Turn records and native settings events keep their own source order and identity. Repeated observations are not additional turns.</p>
          {data.turns.length ? <ol className="list-decimal pl-5 flex flex-col gap-3">{data.turns.map((turn, index) => <li key={index} className="text-ui wrap-anywhere">
            <p>Model: {turn.model ?? 'Not recorded'} · Effort: {turn.effort ?? 'Not recorded'}</p>
            <p className="meta">{turn.source} · Session {turn.agentId ?? 'unknown'} · Turn {turn.turnId ?? 'unknown'} · Source line {turn.sourceLine ?? 'unknown'}</p>
          </li>)}</ol> : <p className="text-ui">Historical turn settings are unavailable from this source.</p>}
        </Disclosure>
        <Disclosure label={`Skill observations (${observedSkills.length})`} expandedLabel="Hide skill observations">
          {observedSkills.length ? <ul className="list-disc pl-5 text-ui">{observedSkills.map((skill, index) => <li key={index} className="wrap-anywhere"><strong>{skill.name}</strong>
            <ul className="list-disc pl-5">{skill.observations.map((observation, index) => <li key={index}>{observation.kind} · session {observation.agentId ?? 'unknown'} · turn {observation.turnId ?? 'unknown'} · <SkillReference reference={observation.sourceRef} /></li>)}</ul>
          </li>)}</ul> : <p className="text-ui">No skill observations retained. This does not establish that no skills were loaded.</p>}
        </Disclosure>
        {catalogOnlySkills.length ? <Disclosure label={`Catalog-only skills (${catalogOnlySkills.length})`} expandedLabel="Hide catalog-only skills">
          <p className="hint">These entries have no retained skill observations. Catalog presence does not prove use.</p>
          <ul className="list-disc pl-5 text-ui">{catalogOnlySkills.map((skill, index) => <li key={index} className="wrap-anywhere">{skill.name}</li>)}</ul>
        </Disclosure> : null}
        <Subheading className="text-body font-semibold">Compaction and scope</Subheading>
        <p className="hint">A recorded summary is not the full effective context. Compare the opening goal with summaries and later activity to judge scope yourself.</p>
        {data.compactions.length ? <div className="flex flex-wrap gap-2">{data.compactions.map(event => <Button key={event.eventId} onClick={() => onOpenCompaction(event.sessionId, event.eventId)}>{event.label}</Button>)}</div>
          : <p className="text-ui">No compaction events are available in this replay. This does not prove the session never compacted.</p>}
        {data.setupHref ? <Link to={data.setupHref}>Inspect today’s setup (a separate snapshot)</Link> : null}
      </section>;
}
