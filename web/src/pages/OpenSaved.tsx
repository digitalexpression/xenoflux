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
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const COPILOT_SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const TRANSCRIPT_NAME = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.jsonl$/i;

export function OpenSaved() {
  const recent = useResource(() => apiGet<SavedReportsView>('/api/reports/recent'), 'recent');
  const [summary, setSummary] = useState<SavedSummary | null>(null);
  const [problem, setProblem] = useState<{ kind: 'json-missing' | 'error'; text: string; markdown?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [transcripts, setTranscripts] = useState<[File | null, File | null]>([null, null]);
  const [importProblem, setImportProblem] = useState<string | null>(null);
  const [copilotIds, setCopilotIds] = useState<[string, string]>(['', '']);
  const [copilotImporting, setCopilotImporting] = useState(false);
  const [copilotProblem, setCopilotProblem] = useState<string | null>(null);
  const copilotLeftId = useId(), copilotRightId = useId(), copilotHintId = useId();
  const pending = useRef(false);
  const leftId = useId(), rightId = useId(), importHintId = useId();
  const fileId = useId(), hintId = useId();
  const input = useRef<HTMLInputElement>(null);
  const saved = useRef<HTMLElement>(null);
  useEffect(() => { if (summary) saved.current?.focus(); }, [summary]);

  async function choose(file: File) {
    if (pending.current) return;
    pending.current = true;
    setImportProblem(null); setCopilotProblem(null);
    setBusy(true); setProblem(null); setSummary(null);
    try {
      if (file.size > MAX_BYTES) throw new ApiError(413, 'This file is larger than a saved report can be.', 'too-large');
      const text = /\.md$/i.test(file.name) ? '' : await file.text();
      setSummary(await apiPost<SavedSummary>('/api/reports/open', { fileName: file.name, text }));
    } catch (error) {
      if (error instanceof ApiError && error.code === 'json-missing') setProblem({ kind: 'json-missing', text: error.message, markdown: file.name });
      else setProblem({ kind: 'error', text: (error as Error).message });
    } finally { pending.current = false; setBusy(false); if (input.current) input.current.value = ''; }
  }

  async function openRecent(id: string) {
    if (pending.current) return;
    pending.current = true;
    setImportProblem(null); setCopilotProblem(null);
    setBusy(true); setProblem(null);
    try { setSummary(await apiPost<SavedSummary>(`/api/reports/recent/${encodeURIComponent(id)}/open`)); }
    catch (error) { setProblem({ kind: 'error', text: (error as Error).message }); }
    finally { pending.current = false; setBusy(false); }
  }


  async function importTranscripts() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true); setImporting(true); setCopilotProblem(null); setImportProblem(null); setProblem(null); setSummary(null);
    try {
      const read = async (file: File | null, side: string) => {
        if (!file) throw new Error(`Choose the ${side} Claude transcript.`);
        if (!TRANSCRIPT_NAME.test(file.name)) throw new Error('Choose UUID-named .jsonl files from Claude Code.');
        if (!file.size) throw new Error('The selected transcript is empty.');
        if (file.size > MAX_TRANSCRIPT_BYTES) throw new Error('Each Claude transcript must be 8 MiB or smaller.');
        let text: string;
        try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer()); }
        catch { throw new Error('The selected transcript must contain valid UTF-8 text.'); }
        return { fileName: file.name, text };
      };
      const [left, right] = await Promise.all([read(transcripts[0], 'first'), read(transcripts[1], 'second')]);
      setSummary(await apiPost<SavedSummary>('/api/reports/import/claude-code', { left, right }));
    } catch (error) { setImportProblem((error as Error).message); }
    finally { pending.current = false; setBusy(false); setImporting(false); }
  }

  async function importCopilot() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true); setCopilotImporting(true); setCopilotProblem(null); setImportProblem(null); setProblem(null); setSummary(null);
    try {
      if (!copilotIds.every(id => COPILOT_SESSION_ID.test(id))) {
        setCopilotProblem('Enter two existing Copilot session UUIDs (8-4-4-4-12 hexadecimal characters).');
        return;
      }
      setSummary(await apiPost<SavedSummary>('/api/reports/import/copilot', {
        left: { sessionId: copilotIds[0] }, right: { sessionId: copilotIds[1] },
      }));
    } catch (error) {
      setCopilotProblem(error instanceof ApiError ? error.message : 'The stored conversations could not be read. Check the session IDs and your existing Copilot CLI sign-in, then try again.');
    } finally { pending.current = false; setBusy(false); setCopilotImporting(false); }
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
          {busy && !importing && !copilotImporting ? <p className="hint" role="status">Reading the saved report…</p> : null}
        </section>
        <section className="panel flex flex-col gap-3" style={{ flex: '1 1 320px' }} aria-labelledby="recently-saved">
          <h2 id="recently-saved" className="text-body font-semibold">Recently saved</h2>
          {recent.loading && !recent.data ? <Loading label="Reading saved reports…" rows={1} /> : null}
          {recent.data?.recent.length ? (
            <ul className="list-none p-0 flex flex-col gap-1">
              {recent.data.recent.map(item => (
                <li key={item.id}>
                  <button type="button" className="row-select w-full text-left border-0 bg-transparent flex-col gap-0.5" onClick={() => void openRecent(item.id)} disabled={busy}>
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
      <details className="panel min-w-0">
        <summary className="text-body font-semibold cursor-pointer">Import Claude Code transcripts</summary>
        <form className="mt-3 flex min-w-0 flex-col gap-3" onSubmit={event => { event.preventDefault(); void importTranscripts(); }}>
          <p id={importHintId} className="text-ui">Choose two existing Claude Code transcripts named with their session UUID and ending in .jsonl, up to 8 MiB each. Only the selected snapshots are read. No agent or task is started.</p>
          {[leftId, rightId].map((id, index) => <div key={id} className="min-w-0">
            <label htmlFor={id} className="field-label">{index === 0 ? 'First' : 'Second'} Claude transcript</label>
            <input id={id} type="file" accept=".jsonl" className="input" required disabled={busy} aria-describedby={importHintId}
              onChange={event => {
                const file = event.target.files?.[0] ?? null;
                setTranscripts(previous => index === 0 ? [file, previous[1]] : [previous[0], file]);
                setImportProblem(null); setCopilotProblem(null);
              }} />
          </div>)}
          <p className="hint">Earlier compacted conversation and tool history may be missing. Account, model, usage and the original app surface remain unknown.</p>
          <Button type="submit" className="self-start max-w-full" disabled={busy} busy={importing} busyLabel="Reading stored conversations…">Compare stored conversations</Button>
          {importProblem ? <ErrorPanel title="Couldn’t import these transcripts">{importProblem} Nothing was opened.</ErrorPanel> : null}
        </form>
      </details>
      <details className="panel min-w-0">
        <summary className="text-body font-semibold cursor-pointer">Import Copilot conversations</summary>
        <form className="mt-3 flex min-w-0 flex-col gap-3" onSubmit={event => { event.preventDefault(); void importCopilot(); }}>
          <p id={copilotHintId} className="text-ui">Enter two existing local session UUIDs copied from Copilot CLI or the app. This uses your existing Copilot CLI sign-in and local history. Enter IDs, not links.</p>
          {[copilotLeftId, copilotRightId].map((id, index) => <div key={id} className="min-w-0">
            <label htmlFor={id} className="field-label">{index === 0 ? 'First' : 'Second'} Copilot session ID</label>
            <input id={id} type="text" className="input" required maxLength={36} pattern="[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}" autoCapitalize="none" autoCorrect="off" spellCheck={false}
              disabled={busy} aria-describedby={copilotHintId} value={copilotIds[index]}
              onChange={event => {
                const value = event.target.value;
                setCopilotIds(previous => index === 0 ? [value, previous[1]] : [previous[0], value]);
                setCopilotProblem(null);
              }} />
          </div>)}
          <p className="hint">Starts the native client only to read stored history; authentication checks may use the network. No new session, prompt or model task is submitted. Missing history and source unknowns remain explicit.</p>
          <Button type="submit" className="self-start max-w-full" disabled={busy} busy={copilotImporting} busyLabel="Reading Copilot conversations…">Compare Copilot conversations</Button>
          {copilotProblem ? <ErrorPanel title="Couldn’t import these Copilot conversations">{copilotProblem} Nothing was opened.</ErrorPanel> : null}
        </form>
      </details>
      {problem?.kind === 'json-missing' ? (
        <WarningAlert live title={problem.text} actions={<><Button onClick={() => input.current?.click()} disabled={busy}>Locate the JSON file</Button><Button onClick={() => setProblem(null)} disabled={busy}>Cancel</Button></>}>
          You can still read the Markdown file. Xenoflux can’t reopen the saved report without its JSON file, and won’t rebuild it from current sessions.
        </WarningAlert>
      ) : problem ? <ErrorPanel title="Couldn’t open this report">{problem.text} Nothing was opened.</ErrorPanel> : null}
      {summary ? (
        <section ref={saved} tabIndex={-1} className="flex flex-col gap-3" aria-labelledby="saved-summary">
          <InfoNotice title={<span id="saved-summary" className="inline-flex flex-wrap items-center gap-2"><TagPill>{(summary.origin === 'claude-code-import' || summary.origin === 'copilot-import') ? 'Imported conversations' : 'Saved report'}</TagPill><span className="wrap-anywhere">{summary.title}</span></span>}>
            {(summary.origin === 'claude-code-import' || summary.origin === 'copilot-import') ? <p>Imported stored conversations. Missing earlier state and source unknowns remain explicit.</p>
              : <p>Recorded {summary.recordedAt} · saved {summary.savedAt} · shown exactly as saved; today’s setup and files aren’t used.</p>}
            {summary.sides?.length ? <div className="report-sides text-ui">{summary.sides.map(side => <div className="wrap-anywhere" key={side.side}>
              <p className="font-semibold">{side.side} · {side.profile}</p><p>{side.detail} · {side.checks}</p>
            </div>)}</div> : null}
          </InfoNotice>
          <dl className="panel saved-report-facts text-ui">
            {summary.kept.map(item => <div key={item.label}><dt className="font-medium">{item.label}</dt><dd>{item.value}</dd></div>)}
          </dl>
          <div className="flex flex-wrap gap-2">
            <Link className="btn btn-primary" to={summary.href ?? `/reports/${encodeURIComponent(summary.ref)}`}>View report</Link>
            <CopyButton text={summary.cliCommand} label="Copy CLI command" />
          </div>
        </section>
      ) : null}
    </Page>
  );
}
