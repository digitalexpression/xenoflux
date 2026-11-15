import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation, useNavigate } from 'react-router';
import { ArrowLeft, ArrowLeftRight, ArrowRight, Columns2, History, Users, X, type LucideIcon } from 'lucide-react';
import type { Info } from '@/api/types';
import { host } from '@/host';
import { setTheme, storedTheme, type ThemeChoice } from '@/lib/theme';
import { cn } from '@/lib/cn';
import { swapTray, toggleTray, trayFull, useTray } from '@/lib/tray';
import { ErrorPanel } from './notices';
import { Button } from './ui/button';

export type NavKey = 'setup' | 'compare' | 'profiles' | 'sessions' | 'open' | 'activity' | null;

export const InfoContext = createContext<Info | null>(null);
export const useInfo = () => useContext(InfoContext);

/** Where the current page's breadcrumb renders: the shell toolbar. */
const CrumbSlotContext = createContext<HTMLElement | null>(null);

type NavItem = { key: Exclude<NavKey, null>; label: string; to: string };
// Three destinations, one per object people work with. A destination stays
// marked while one of its secondary pages is open.
const NAV: (NavItem & { icon: LucideIcon; children: NavItem[] })[] = [
  { key: 'sessions', label: 'Sessions', to: '/sessions', icon: History, children: [] },
  { key: 'compare', label: 'Comparisons', to: '/comparisons', icon: Columns2, children: [{ key: 'open', label: 'Saved reports', to: '/reports/open' }] },
  { key: 'profiles', label: 'Profiles', to: '/profiles', icon: Users, children: [{ key: 'setup', label: 'Clients on this Mac', to: '/setup' }] },
];

export function AppSidebar({ current }: { current: NavKey }) {
  const info = useInfo();
  const jobs = info?.activeJobs ?? (info?.activeRun ? [{ ...info.activeRun, kind: 'comparison' }] : []);
  return (
    <header className="app-sidebar">
      <Link to="/comparisons" className="app-brand" aria-label="Xenoflux home">
        <span aria-hidden="true" className="app-brand-mark" />
        <span>Xenoflux</span>
      </Link>
      <nav aria-label="Primary" className="app-nav">
        {NAV.map(({ icon: Icon, children, ...item }) => (
          <div key={item.key} className="app-nav-group">
            <Link to={item.to} className="nav-link" aria-current={current === item.key ? 'page' : undefined}
              data-active={children.some(child => child.key === current) || undefined}>
              <Icon size={16} aria-hidden="true" />{item.label}
            </Link>
            {children.map(child => (
              <Link key={child.key} to={child.to} className="nav-link nav-sub" aria-current={current === child.key ? 'page' : undefined}>{child.label}</Link>
            ))}
          </div>
        ))}
      </nav>
      <ComparisonTray />
      <section className="app-activity" aria-labelledby="activity-title">
        <h2 id="activity-title" className="meta font-medium"><Link to="/activity" aria-current={current === 'activity' ? 'page' : undefined}>Activity</Link></h2>
        {jobs.length ? (
          <>
            <p className="text-ui font-semibold">{jobs.length} {jobs.length === 1 ? 'job' : 'jobs'} in progress{info?.maxActiveJobs ? ` · capacity ${info.maxActiveJobs}` : ''}</p>
            <ul className="list-none p-0 flex flex-col gap-1">
              {jobs.map(job => <li key={job.href}><Link className="text-ui wrap-anywhere" to={job.href}>
                {job.kind === 'review' ? 'Review' : 'Comparison'} · {job.task} · {job.profiles.join(' then ')}
              </Link></li>)}
            </ul>
          </>
        ) : <div className="meta">No jobs running.</div>}
      </section>
      <div className="app-sidebar-foot">
        <ThemeSelect />
        <span className="meta">{info?.mode === 'demo' ? 'Demo data · nothing on this Mac is read or changed' : 'Local app · this Mac only'}</span>
      </div>
    </header>
  );
}

/**
 * The pair being assembled for a comparison, visible from every page once a
 * session is picked. The picker page shows the same pair in full, so the tray
 * steps aside there.
 */
function ComparisonTray() {
  const tray = useTray();
  const { pathname } = useLocation();
  if ((!tray.left && !tray.right) || pathname === '/compare/sessions') return null;
  const full = trayFull(tray);
  return (
    <section className="app-tray" aria-labelledby="tray-title">
      <h2 id="tray-title" className="meta font-medium">Comparison</h2>
      <ul className="list-none p-0 flex flex-col gap-2">
        {(['a', 'b'] as const).map(side => {
          const row = side === 'a' ? tray.left : tray.right;
          return (
            <li key={side} className="tray-slot" data-side={side} data-filled={Boolean(row)}>
              <div className="flex flex-col min-w-0 flex-1">
                <span className="meta">{side === 'a' ? 'Left' : 'Right'}</span>
                {row ? <>
                  <span className="text-ui font-medium wrap-anywhere">{row.title}</span>
                  <span className={cn('meta font-semibold wrap-anywhere', side === 'a' ? 'side-a' : 'side-b')}>{row.profile}</span>
                </> : <span className="text-ui muted">Add one more session</span>}
              </div>
              {row ? <Button size="icon" variant="ghost-link" className="tray-remove" aria-label={`Remove ${row.title} (${row.profile}) from the comparison`}
                onClick={() => toggleTray(row)}><X size={14} aria-hidden="true" /></Button> : null}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap gap-2">
        {full ? <Link className="btn btn-primary flex-1" to="/compare/sessions">Compare…</Link>
          : <Link className="btn flex-1" to="/sessions">Find a session</Link>}
        {full ? <Button size="icon" className="tray-swap" aria-label="Swap sides" onClick={swapTray}><ArrowLeftRight size={16} aria-hidden="true" /></Button> : null}
      </div>
    </section>
  );
}

/** History controls and the page's breadcrumb; no browser toolbar is assumed. */
function AppToolbar({ setCrumbSlot }: { setCrumbSlot: (element: HTMLElement | null) => void }) {
  const navigate = useNavigate();
  return (
    <div className="app-toolbar">
      <div className="flex gap-1">
        <Button size="icon" variant="ghost-link" className="app-toolbar-button" aria-label="Go back" onClick={() => navigate(-1)}><ArrowLeft size={16} aria-hidden="true" /></Button>
        <Button size="icon" variant="ghost-link" className="app-toolbar-button" aria-label="Go forward" onClick={() => navigate(1)}><ArrowRight size={16} aria-hidden="true" /></Button>
      </div>
      <div ref={setCrumbSlot} className="min-w-0 flex-1" />
    </div>
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
  const slot = useContext(CrumbSlotContext);
  const trail = breadcrumb?.length ? (
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
  ) : null;
  // Page titles can arrive after an asynchronous read. Focus when the title
  // mounts, without moving focus again for filters or evidence selections.
  useEffect(() => { heading.current?.focus(); }, []);
  return (
    <div className="flex flex-col gap-2">
      {trail ? (slot ? createPortal(trail, slot) : trail) : null}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <h1 ref={heading} tabIndex={-1} className={cn('text-title wrap-anywhere', titleClassName)}>{title}</h1>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
      {subtitle ? <p className="text-body muted max-w-[72ch] wrap-anywhere">{subtitle}</p> : null}
    </div>
  );
}

export function Page({ current, children, reading = false, title }: { current: NavKey; children: ReactNode; reading?: boolean; title: string }) {
  const [crumbSlot, setCrumbSlot] = useState<HTMLElement | null>(null);
  useEffect(() => { host.setTitle(`${title} · Xenoflux`); }, [title]);
  return (
    <div className="app-shell">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:m-2 btn">Skip to content</a>
      <AppSidebar current={current} />
      <div className="app-main">
        <AppToolbar setCrumbSlot={setCrumbSlot} />
        <CrumbSlotContext.Provider value={crumbSlot}>
          <main id="main" tabIndex={-1} className={cn('page', reading && 'page-reading')}>{children}</main>
        </CrumbSlotContext.Provider>
      </div>
    </div>
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
