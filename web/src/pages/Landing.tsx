import { Link } from 'react-router';
import { apiGet } from '@/api/client';
import type { Overview } from '@/api/types';
import { TagPill } from '@/components/badges';
import { Loading, LoadError, Page, PageTitle, useInfo } from '@/components/layout';
import { useResource } from '@/lib/useResource';

const KIND = { task: 'Task', setup: 'Setup', saved: 'Saved' } as const;

/** Two equal entries; nothing is preselected (DESIGN.md › Layout). */
export function Landing() {
  const info = useInfo();
  const overview = useResource(() => apiGet<Overview>('/api/overview'), 'overview');
  const data = overview.data;
  const needsTwo = data !== null && data.profileCount < 2;
  return (
    <Page current="compare" title="Compare">
      <PageTitle title="What do you want to compare?" />
      {overview.error ? <LoadError error={overview.error} onRetry={overview.reload} /> : null}
      {data && data.profileCount === 0 ? (
        <section className="panel flex flex-col gap-3" aria-labelledby="no-profiles">
          <h2 id="no-profiles" className="text-heading">Add a profile to start</h2>
          <p className="muted">Xenoflux compares Codex profiles. Add an existing Codex folder, or create a profile.</p>
          <div className="flex flex-wrap gap-2">
            <Link className="btn" to="/profiles?add=1">Add an existing Codex folder…</Link>
            <Link className="btn" to="/profiles?create=1">Create profile…</Link>
          </div>
        </section>
      ) : (
        <div className="grid gap-6" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))' }}>
          <section className="panel flex flex-col gap-4" aria-labelledby="compare-task">
            <div className="flex flex-col gap-1">
              <h2 id="compare-task" className="text-heading">Compare a task</h2>
              <p className="muted">See what two profiles did on the same task, what they produced, and what couldn’t be seen.</p>
            </div>
            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))' }}>
              <EntryTile to="/compare/sessions" title="Use existing sessions" text="Work you already did in Codex CLI or Desktop. Reads history only."
                status={data ? data.sessions.text : 'Reading sessions…'} />
              {info?.features.runs ? (
                <EntryTile to="/runs/new" title="Run a new task" text="Run one task in two profiles. Nothing starts until you review it."
                  status={data ? (needsTwo ? 'Needs two profiles' : data.runs.text) : 'Checking profiles…'} disabledReason={needsTwo ? 'Needs two profiles. Add or create one in Profiles.' : undefined} />
              ) : null}
            </div>
          </section>
          <section className="panel flex flex-col gap-4" aria-labelledby="compare-setups">
            <div className="flex flex-col gap-1">
              <h2 id="compare-setups" className="text-heading">Compare setups</h2>
              <p className="muted">See how two profiles’ instructions, skills, tools and settings differ today.</p>
            </div>
            <p className="text-meta font-medium mt-auto">{data ? (needsTwo ? 'Needs two profiles' : data.setups.text) : 'Reading profiles…'}</p>
            <div>
              {needsTwo
                ? <Link className="btn" to="/profiles">Needs two profiles · open Profiles</Link>
                : <Link className="btn" to="/compare/setups">Choose two profiles</Link>}
            </div>
          </section>
        </div>
      )}
      <section className="flex flex-col gap-3" aria-labelledby="recent">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          {data?.recent.length ? <h2 id="recent" className="text-heading">Recent</h2> : <h2 id="recent" className="sr-only">Saved reports</h2>}
          <Link to="/reports/open">Open a saved report…</Link>
        </div>
        {overview.loading && !data ? <Loading label="Reading recent work…" rows={2} /> : null}
        {data?.recent.length ? (
          <ul className="panel p-0 list-none">
            {data.recent.map((item, index) => (
              <li key={index} className="flex flex-wrap items-center gap-3 px-4 py-3 border-b last:border-b-0" style={{ borderColor: 'var(--color-divider)' }}>
                <TagPill>{KIND[item.kind]}</TagPill>
                <Link to={item.href} className="font-medium wrap-anywhere">{item.title}</Link>
                <span className="meta">{item.meta}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </Page>
  );
}

function EntryTile({ to, title, text, status, disabledReason }: { to: string; title: string; text: string; status: string; disabledReason?: string }) {
  const body = (
    <>
      <span className="font-semibold" style={{ color: disabledReason ? 'var(--color-text-muted)' : 'var(--color-on-selected)' }}>{title}</span>
      <span className="hint">{disabledReason ?? text}</span>
      <span className="text-meta font-medium mt-auto">{status}</span>
    </>
  );
  const className = 'flex flex-col gap-1.5 rounded-control px-4 py-3.5 no-underline min-h-[132px]';
  const style = { border: '1px solid var(--color-action-border)', background: 'var(--color-surface-raised)', color: 'var(--color-text)' };
  if (disabledReason) return <div className={className} style={{ ...style, borderColor: 'var(--color-divider)' }} aria-disabled="true">{body}</div>;
  return <Link to={to} className={className} style={style}>{body}</Link>;
}
