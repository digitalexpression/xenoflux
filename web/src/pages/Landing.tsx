import { useId } from 'react';
import { Link } from 'react-router';
import { Bookmark, ChevronRight, Columns2, FolderOpen, History, Info, LockKeyhole, Play,
  ScanSearch, SlidersHorizontal, SquareTerminal, type LucideIcon } from 'lucide-react';
import { apiGet } from '@/api/client';
import type { Overview, RecentItem } from '@/api/types';
import { Loading, LoadError, Page, PageTitle, useInfo } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { useResource } from '@/lib/useResource';

const recentKinds = {
  task: { label: 'Task', icon: SquareTerminal },
  setup: { label: 'Setup', icon: SlidersHorizontal },
  saved: { label: 'Saved report', icon: Bookmark },
};

export function Landing() {
  const info = useInfo();
  const overview = useResource(() => apiGet<Overview>('/api/overview'), 'overview');
  const data = overview.data;
  const sessionStatus = data?.sessions.text ?? (overview.loading ? 'Reading sessions…' : null);
  const setupStatus = data?.setups.text ?? (overview.loading ? 'Reading profiles…' : null);
  return (
    <Page current="compare" title="Comparisons">
      <PageTitle title="Comparisons" breadcrumb={[{ label: 'Comparisons' }]} />
      {overview.error ? <LoadError error={overview.error} onRetry={overview.reload} /> : null}
      <div className="landing-groups">
        <section className="panel p-0 landing-group" aria-labelledby="compare-task">
          <h2 id="compare-task" className="panel-head landing-group-heading"><SquareTerminal size={16} aria-hidden="true" /> Compare a task</h2>
          <ul className="landing-actions list-none p-0">
            <li><ActionLink to="/compare/sessions" title="Use existing sessions" icon={History}
              description="Compare two recorded sessions. Reads history only." /></li>
            {info?.features.runs ? <li><ActionLink to="/runs/new" title="Run a new task" icon={Play}
              description="Prepare one task for two execution setups."
              status={data?.runs.text ?? (overview.loading ? 'Checking profiles…' : undefined)} /></li> : null}
          </ul>
          {sessionStatus ? <p className="landing-group-note meta"><Info size={14} aria-hidden="true" /> {sessionStatus}</p> : null}
        </section>
        <section className="panel p-0 landing-group" aria-labelledby="compare-setups">
          <h2 id="compare-setups" className="panel-head landing-group-heading"><SlidersHorizontal size={16} aria-hidden="true" /> Compare setups</h2>
          <ul className="landing-actions list-none p-0">
            <li><ActionLink to="/compare/setups" title="Choose two profiles" icon={Columns2}
              description="Compare current settings, skills and integrations." /></li>
            <li><ActionLink to="/profiles" title="Inspect a setup" icon={ScanSearch}
              description="Read one profile’s current setup." /></li>
          </ul>
          {setupStatus ? <p className="landing-group-note meta"><LockKeyhole size={14} aria-hidden="true" /> {setupStatus}</p> : null}
        </section>
      </div>
      <section className="flex flex-col gap-2" aria-labelledby="recent">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          {data?.recent.length ? <h2 id="recent" className="text-body">Recent comparisons</h2> : <h2 id="recent" className="sr-only">Saved reports</h2>}
          <Button asChild variant="ghost-link"><Link to="/reports/open"><FolderOpen size={16} aria-hidden="true" /> Open saved report</Link></Button>
        </div>
        {overview.loading && !data ? <Loading label="Reading recent work…" rows={2} /> : null}
        {data?.recent.length ? <ul className="panel p-0 list-none landing-recent">
          {data.recent.map((item, index) => <li key={index}><RecentLink item={item} /></li>)}
        </ul> : null}
      </section>
    </Page>
  );
}

function ActionLink({ to, title, icon: Icon, description, status }: {
  to: string; title: string; icon: LucideIcon; description: string; status?: string;
}) {
  const id = useId();
  return <Link to={to} className="landing-action" aria-labelledby={`${id}-title`} aria-describedby={`${id}-detail`}>
    <Icon size={16} aria-hidden="true" />
    <span className="landing-action-copy min-w-0 wrap-anywhere">
      <span className="text-ui font-semibold" id={`${id}-title`}>{title}</span>
      <span className="meta" id={`${id}-detail`}>{description}{status ? <span className="block">{status}</span> : null}</span>
    </span>
    <ChevronRight size={16} aria-hidden="true" />
  </Link>;
}

function RecentLink({ item }: { item: RecentItem }) {
  const id = useId();
  const { icon: Icon, label } = recentKinds[item.kind];
  return <Link to={item.href} className="landing-recent-link" aria-labelledby={`${id}-title`} aria-describedby={`${id}-detail`}>
    <Icon size={16} aria-hidden="true" />
    <span className="text-ui font-medium wrap-anywhere" id={`${id}-title`}>{item.title}</span>
    <span className="meta landing-recent-meta wrap-anywhere" id={`${id}-detail`}><span className="sr-only">{label} · </span>{item.meta}</span>
    <ChevronRight size={16} aria-hidden="true" />
  </Link>;
}
