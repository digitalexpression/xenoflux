import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { Info } from '@/api/types';
import { setTheme, storedTheme, type ThemeChoice } from '@/lib/theme';
import { cn } from '@/lib/cn';
import { ErrorPanel } from './notices';
import { Button } from './ui/button';

export type NavKey = 'setup' | 'compare' | 'profiles' | 'sessions' | 'open' | null;

export const InfoContext = createContext<Info | null>(null);
export const useInfo = () => useContext(InfoContext);

const NAV: { key: Exclude<NavKey, null>; label: string; to: string }[] = [
  { key: 'setup', label: 'Setup', to: '/setup' },
  { key: 'compare', label: 'Compare', to: '/' },
  { key: 'profiles', label: 'Profiles', to: '/profiles' },
  { key: 'sessions', label: 'Browse sessions', to: '/sessions' },
  { key: 'open', label: 'Open saved report', to: '/reports/open' },
];

export function AppHeader({ current }: { current: NavKey }) {
  const info = useInfo();
  const jobs = info?.activeJobs ?? (info?.activeRun ? [{ ...info.activeRun, kind: 'comparison' }] : []);
  return (
    <header className="app-header">
      <div className="app-header-inner">
        <Link to="/" className="inline-flex items-center gap-2 no-underline" style={{ color: 'var(--color-text)' }} aria-label="Xenoflux home">
          <span aria-hidden="true" className="inline-block w-2.5 h-2.5" style={{ background: 'linear-gradient(135deg, var(--color-action) 50%, var(--color-accent) 50%)' }} />
          <span className="font-mono font-semibold text-body">xenoflux</span>
        </Link>
        <nav aria-label="Primary" className="flex flex-wrap gap-x-4">
          {NAV.map(item => (
            <Link key={item.key} to={item.to} className="nav-link" aria-current={current === item.key ? 'page' : undefined}>{item.label}</Link>
          ))}
        </nav>
        <span className="meta ml-auto">{info?.mode === 'demo' ? 'Demo data · nothing on this Mac is read or changed' : 'Local app · this Mac only'}</span>
        <ThemeSelect />
      </div>
      {jobs.length > 0 ? (
        <div className="notice rounded-none">
          <div className="max-w-[var(--content-max)] mx-auto px-[var(--page-gutter)] flex flex-wrap gap-x-4 gap-y-1 text-ui">
            <strong className="font-semibold">{jobs.length} {jobs.length === 1 ? 'job' : 'jobs'} in progress{info?.maxActiveJobs ? ` · capacity ${info.maxActiveJobs}` : ''}</strong>
            {jobs.map(job => <Link key={job.href} className="wrap-anywhere" to={job.href}>
              {job.kind === 'review' ? 'Review' : 'Comparison'} · {job.task} · {job.profiles.join(' then ')}
            </Link>)}
          </div>
        </div>
      ) : null}
    </header>
  );
}

function ThemeSelect() {
  const [choice, setChoice] = useState<ThemeChoice>(storedTheme);
  return (
    <label className="meta inline-flex items-center gap-2">
      Theme
      <select className="input w-auto" value={choice}
        onChange={event => { const value = event.target.value as ThemeChoice; setChoice(value); setTheme(value); }}>
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}

export interface Crumb { label: string; to?: string }

export function PageTitle({ breadcrumb, title, subtitle, actions, titleClassName }:
  { breadcrumb?: Crumb[]; title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; titleClassName?: string }) {
  const heading = useRef<HTMLHeadingElement>(null);
  // Page titles can arrive after an asynchronous read. Focus when the title
  // mounts, without moving focus again for filters or evidence selections.
  useEffect(() => { heading.current?.focus(); }, []);
  return (
    <div className="flex flex-col gap-2">
      {breadcrumb?.length ? (
        <nav aria-label="Breadcrumb">
          <ol className="flex flex-wrap gap-2 meta list-none p-0">
            {breadcrumb.map((crumb, index) => (
              <li key={index} className="flex gap-2">
                {crumb.to ? <Link to={crumb.to} className="muted">{crumb.label}</Link> : <span aria-current="page">{crumb.label}</span>}
                {index < breadcrumb.length - 1 ? <span aria-hidden="true">/</span> : null}
              </li>
            ))}
          </ol>
        </nav>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <h1 ref={heading} tabIndex={-1} className={cn('text-title wrap-anywhere', titleClassName)}>{title}</h1>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
      {subtitle ? <p className="text-body muted max-w-[72ch] wrap-anywhere">{subtitle}</p> : null}
    </div>
  );
}

export function Page({ current, children, reading = false, title }: { current: NavKey; children: ReactNode; reading?: boolean; title: string }) {
  useEffect(() => { document.title = `${title} · Xenoflux`; }, [title]);
  return (
    <>
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:m-2 btn">Skip to content</a>
      <AppHeader current={current} />
      <main id="main" tabIndex={-1} className={cn('page', reading && 'page-reading')}>{children}</main>
    </>
  );
}

/** Named progress with skeleton rows; never a fake count or percentage. */
export function Loading({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div className="flex flex-col gap-3" role="status" aria-live="polite">
      <span className="hint">{label}</span>
      {Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton" style={{ height: 44 }} aria-hidden="true" />)}
    </div>
  );
}

export function LoadError({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <ErrorPanel title="Couldn't load this page" actions={onRetry ? <Button onClick={onRetry}>Try again</Button> : undefined}>
      {error.message}
    </ErrorPanel>
  );
}
