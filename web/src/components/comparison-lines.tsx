import type { Report, ReplayEvent, ReplaySession, Side } from '@/api/types';
import { replayNames } from '@/components/session-replay';
import { SideText } from '@/components/profile';

type Stop = { event: ReplayEvent; label: string; at: number | null };
function stopsFor(session: ReplaySession): Stop[] {
  const turns = new Set<string>();
  let turn = 0;
  return session.events.flatMap(event => {
    if (event.turnId && turns.has(event.turnId)) return [];
    if (event.turnId) turns.add(event.turnId);
    const timestamp = event.timestamp ? Date.parse(event.timestamp) : NaN;
    return [{ event, label: event.turnId ? `Turn ${++turn}` : event.label, at: Number.isFinite(timestamp) ? timestamp : null }];
  });
}
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function ComparisonLines({ data, onOpen }: { data: Report; onOpen: (side: Side, sessionId: string, event: ReplayEvent, trigger: HTMLButtonElement) => void }) {
  return <section className="comparison-lines panel" aria-labelledby="comparison-lines-title">
    <div className="comparison-section-heading"><h2 id="comparison-lines-title" className="text-heading">Recorded activity</h2><a href="#report-activity">Full activity and conversations</a></div>
    <p className="hint">Dotted lanes show recorded order. Open a stop to inspect its source event.</p>
    {(['a', 'b'] as const).map(side => {
      const replay = data.replay?.[side];
      const names = replayNames(replay ?? null);
      return <div key={side} className="comparison-line-side" data-side={side}>
        {replay?.sessions.length ? replay.sessions.map(session => {
          const stops = stopsFor(session), shown = stops.slice(0, 20);
          const start = stops[0]?.at ?? 0, end = stops.at(-1)?.at ?? start;
          const clockSources = new Set(stops.map(stop => stop.event.timestampSource ?? 'recorded'));
          const timed = end > start && clockSources.size === 1 && stops.every((stop, index) => stop.at !== null
            && (!index || (stop.at - (stops[index - 1]?.at ?? Infinity)) / (end - start) >= 1 / 16));
          const parent = session.parentId ? replay.sessions.find(row => row.id === session.parentId) : null;
          const title = names.get(session.id) ?? 'Recorded session';
          if (parent) {
            const first = session.events[0];
            return <div key={session.id} className="comparison-branch" data-linked="true">
              <svg viewBox="0 0 32 24" width="32" height="24" aria-hidden="true"><path d="M4 0v16h24" fill="none" stroke="currentColor" /></svg>
              {first ? <button type="button" className="btn btn-link" onClick={event => onOpen(side, session.id, first, event.currentTarget)}>{title}</button> : <span className="text-ui">{title}</span>}
              <span className="meta">Delegated · parent {names.get(parent.id) ?? 'recorded session'} · {session.events.length} retained events{first ? '' : ` · ${session.reason ?? 'History unavailable'}`}</span>
            </div>;
          }
          return <div key={session.id} className="comparison-lane">
            <div className="comparison-lane-label"><SideText side={side} className="text-ui">{side === 'a' ? 'Left' : 'Right'} · {data[side].profile}</SideText><span className="text-ui font-medium">{title}</span>
              {session.parentId ? <span className="meta">Parent session unavailable</span> : null}
            </div>
            <div className="comparison-lane-body">
              {shown.length ? <>
                <div className="comparison-stop-track" data-ordered={!timed} role="group" aria-label={`${data[side].profile} · ${title} recorded stops`}>
                  {shown.map((stop, index) => {
                    const position = timed && end > start && stop.at !== null ? 5 + (stop.at - start) / (end - start) * 90 : 5 + index / Math.max(1, shown.length - 1) * 90;
                    const description = stop.at === null ? stop.label
                      : `${stop.label} · ${clock(stop.at)}${stop.event.timestampSource === 'observed' ? ' observed' : ''}`;
                    return <button type="button" key={stop.event.id} className="comparison-stop" style={{ left: `${position}%` }}
                      aria-label={`${data[side].profile} · ${title} · ${description}`} title={description} onClick={event => onOpen(side, session.id, stop.event, event.currentTarget)}>
                      <span className="comparison-stop-circle" aria-hidden="true" /><span className="comparison-stop-index" aria-hidden="true">{index + 1}</span>
                    </button>;
                  })}
                </div>
                <p className="meta">{timed ? `${clock(start)} to ${clock(end)} · this session’s clock` : 'Recorded order · no elapsed-time scale'}{stops.length > shown.length ? ` · first ${shown.length} of ${stops.length} stops; full activity retains the rest` : ` · ${stops.length} ${stops.length === 1 ? 'stop' : 'stops'}`}</p>
              </> : <p className="hint">{session.reason ?? 'No events retained for this session.'}</p>}
            </div>
          </div>;
        }) : <><h3 className="text-ui"><SideText side={side}>{side === 'a' ? 'Left' : 'Right'} · {data[side].profile}</SideText></h3><p className="hint">No replay retained for this side. Activity cannot be reconstructed.</p></>}
      </div>;
    })}
  </section>;
}
