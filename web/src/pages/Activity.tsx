import { Link } from 'react-router';
import { apiGet } from '@/api/client';
import type { Overview } from '@/api/types';
import { Loading, LoadError, Page, PageTitle, useInfo } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { useResource } from '@/lib/useResource';

export function Activity() {
  const info = useInfo();
  const jobs = info?.activeJobs ?? (info?.activeRun ? [{ ...info.activeRun, kind: 'comparison' }] : []);
  const overview = useResource(() => apiGet<Overview>('/api/overview'), JSON.stringify(jobs.map(job => job.id)));
  const recent = overview.data?.recent.filter(item => item.kind === 'task' && !jobs.some(job => job.href === item.href));
  return <Page current="activity" title="Activity">
    <PageTitle title="Activity" subtitle="Follow current work or return to a retained task record."
      actions={<Button busy={overview.loading} busyLabel="Refreshing…" onClick={() => { overview.reload(); window.dispatchEvent(new Event('xenoflux-info-changed')); }}>Refresh activity</Button>} />
    <section className="activity-current" aria-labelledby="current-jobs">
      <div className="run-section-heading"><h2 id="current-jobs" className="text-heading">In progress</h2><span className="hint">{jobs.length} {jobs.length === 1 ? 'job' : 'jobs'}{info?.maxActiveJobs ? ` · capacity ${info.maxActiveJobs}` : ''}</span></div>
      <p className="hint">The job list updates automatically. Open a job for its current state, input requests and cancellation.</p>
      {jobs.length ? <ul className="activity-list">{jobs.map(job => <li key={job.href}>
        <div className="activity-job"><span className="meta">{job.kind === 'review' ? 'Review' : 'Comparison'}</span><Link to={job.href} className="font-medium wrap-anywhere">{job.task}</Link><p className="hint wrap-anywhere">{job.profiles.join(' then ')}</p></div>
        <Link className="btn" to={job.href}>Open progress<span className="sr-only"> for {job.task}</span></Link>
      </li>)}</ul> : <div className="activity-empty"><h3 className="text-body font-semibold">No jobs running</h3><p className="hint">Prepare a new comparison, or inspect work already recorded.</p><div className="flex flex-wrap gap-2"><Link className="btn" to="/runs/new">Run a new task</Link><Link className="btn" to="/sessions">Browse sessions</Link></div></div>}
    </section>
    <section className="activity-recent" aria-labelledby="recent-tasks">
      <h2 id="recent-tasks" className="text-heading">Recent task records</h2>
      <p className="hint">Recent comparisons available to this controller. Opening a record never resumes or retries a model task.</p>
      {overview.error ? <LoadError error={overview.error} onRetry={overview.reload} /> : null}
      {overview.loading && !overview.data ? <Loading label="Reading recent task records…" rows={2} /> : null}
      {recent?.length ? <ul className="activity-list">{recent.map(item => <li key={item.href}><div className="activity-job"><Link className="font-medium wrap-anywhere" to={item.href}>{item.title}</Link><p className="hint wrap-anywhere">{item.meta}</p></div><Link className="btn" to={item.href}>Open record<span className="sr-only"> for {item.title}</span></Link></li>)}</ul>
        : overview.data && !overview.error ? <p className="activity-empty hint">No recent task records are available. Saved reports can still be opened from Comparisons.</p> : null}
    </section>
    <p className="hint">Closing a tab leaves work running. Stopping Xenoflux interrupts its owned work and keeps the evidence; reopening never starts it again.</p>
  </Page>;
}
