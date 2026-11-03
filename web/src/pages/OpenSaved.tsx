import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ApiError, apiGet, apiPost } from '@/api/client';
import type { SavedReportsView, SavedSummary } from '@/api/types';
import { TagPill } from '@/components/badges';
import { Loading, Page, PageTitle } from '@/components/layout';
import { ErrorPanel, InfoNotice, WarningAlert } from '@/components/notices';
import { Button } from '@/components/ui/button';
import { useResource } from '@/lib/useResource';
import { CopyButton } from './Report';

const MAX_BYTES = 60 * 1024 * 1024;

export function OpenSaved() {
  const recent = useResource(() => apiGet<SavedReportsView>('/api/reports/recent'), 'recent');
  const [summary, setSummary] = useState<SavedSummary | null>(null);
  const [problem, setProblem] = useState<{ kind: 'json-missing' | 'error'; text: string; markdown?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const fileId = useId(), hintId = useId();
  const input = useRef<HTMLInputElement>(null);
  const saved = useRef<HTMLElement>(null);
  useEffect(() => { if (summary) saved.current?.focus(); }, [summary]);

  async function choose(file: File) {
    setBusy(true); setProblem(null); setSummary(null);
    try {
      if (file.size > MAX_BYTES) throw new ApiError(413, 'This file is larger than a saved report can be.', 'too-large');
      const text = /\.md$/i.test(file.name) ? '' : await file.text();
      setSummary(await apiPost<SavedSummary>('/api/reports/open', { fileName: file.name, text }));
    } catch (error) {
      if (error instanceof ApiError && error.code === 'json-missing') setProblem({ kind: 'json-missing', text: error.message, markdown: file.name });
      else setProblem({ kind: 'error', text: (error as Error).message });
    } finally { setBusy(false); if (input.current) input.current.value = ''; }
  }

  async function openRecent(id: string) {
    setBusy(true); setProblem(null);
    try { setSummary(await apiPost<SavedSummary>(`/api/reports/recent/${encodeURIComponent(id)}/open`)); }
    catch (error) { setProblem({ kind: 'error', text: (error as Error).message }); }
    finally { setBusy(false); }
  }

  return (
    <Page current="open" title="Open saved report">
      <PageTitle title="Open saved report" subtitle="Opens a report exactly as it was saved, even after the original sessions are gone. Nothing is re-read or rebuilt." />
      <div className="flex flex-wrap gap-6 items-start">
        <section className="panel flex flex-col gap-3" style={{ flex: '1 1 360px' }} aria-labelledby="choose-file">
          <h2 id="choose-file" className="text-body font-semibold">From a file</h2>
          <div>
            <label htmlFor={fileId} className="field-label">Choose the report’s JSON file</label>
            <input ref={input} id={fileId} type="file" accept=".json,.md,application/json" className="input" aria-describedby={hintId} disabled={busy}
              onChange={event => { const file = event.target.files?.[0]; if (file) void choose(file); }} />
            <p id={hintId} className="hint mt-1">The file ending in .audit.json, next to the Markdown file.</p>
          </div>
          {busy ? <p className="hint" role="status">Reading the saved report…</p> : null}
        </section>
        <section className="panel flex flex-col gap-3" style={{ flex: '1 1 320px' }} aria-labelledby="recently-saved">
          <h2 id="recently-saved" className="text-body font-semibold">Recently saved</h2>
          {recent.loading && !recent.data ? <Loading label="Reading saved reports…" rows={1} /> : null}
          {recent.data?.recent.length ? (
            <ul className="list-none p-0 flex flex-col gap-1">
              {recent.data.recent.map(item => (
                <li key={item.id}>
                  <button type="button" className="row-select w-full text-left border-0 bg-transparent flex-col gap-0.5" onClick={() => void openRecent(item.id)}>
                    <span className="font-medium wrap-anywhere">{item.title}</span>
                    {item.sides?.length ? item.sides.map(side => <span key={side.side} className="meta">{side.side} · {side.profile} · {side.detail} · {side.checks}</span>)
                      : <span className="meta">Side details aren’t available from this saved file.</span>}
                    <span className="meta">{item.savedAt}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : recent.data ? <p className="hint">Reports you export from this app appear here.</p> : null}
        </section>
      </div>
      {problem?.kind === 'json-missing' ? (
        <WarningAlert live title={problem.text} actions={<><Button onClick={() => input.current?.click()}>Locate the JSON file</Button><Button onClick={() => setProblem(null)}>Cancel</Button></>}>
          You can still read the Markdown file. Xenoflux can’t reopen the saved report without its JSON file, and won’t rebuild it from current sessions.
        </WarningAlert>
      ) : problem ? <ErrorPanel title="Couldn’t open this report">{problem.text} Nothing was opened.</ErrorPanel> : null}
      {summary ? (
        <section ref={saved} tabIndex={-1} className="flex flex-col gap-3" aria-labelledby="saved-summary">
          <InfoNotice title={<span id="saved-summary" className="inline-flex flex-wrap items-center gap-2"><TagPill>Saved report</TagPill><span className="wrap-anywhere">{summary.title}</span></span>}>
            <p>Recorded {summary.recordedAt} · saved {summary.savedAt} · shown exactly as saved; today’s setup and files aren’t used.</p>
            {summary.sides?.length ? <div className="report-sides text-ui">{summary.sides.map(side => <div className="wrap-anywhere" key={side.side}>
              <p className="font-semibold">{side.side} · {side.profile}</p><p>{side.detail} · {side.checks}</p>
            </div>)}</div> : null}
          </InfoNotice>
          <dl className="panel saved-report-facts text-ui">
            {summary.kept.map(item => <div key={item.label}><dt className="font-medium">{item.label}</dt><dd>{item.value}</dd></div>)}
          </dl>
          <div className="flex flex-wrap gap-2">
            <Link className="btn btn-primary" to={`/reports/${encodeURIComponent(summary.ref)}`}>View report</Link>
            <CopyButton text={summary.cliCommand} label="Copy CLI command" />
          </div>
        </section>
      ) : null}
    </Page>
  );
}
