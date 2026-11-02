import { useEffect, useId, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { ApiError, apiGet, apiPost } from '@/api/client';
import type { ExportPlan, ExportResult } from '@/api/types';
import { StatusBadge } from '@/components/badges';
import { Loading, LoadError, Page, PageTitle, useInfo } from '@/components/layout';
import { ErrorPanel, InfoNotice, SimulatedNote, WarningAlert } from '@/components/notices';
import { Button } from '@/components/ui/button';
import { useResource } from '@/lib/useResource';
import { CopyButton } from './Report';

export function Export() {
  const { ref = '' } = useParams();
  const [searchParams] = useSearchParams();
  const prepareReview = searchParams.get('review') === '1';
  const info = useInfo();
  const plan = useResource(() => apiGet<ExportPlan>(`/api/reports/${encodeURIComponent(ref)}/export`), ref);
  const [includeContent, setIncludeContent] = useState(false);
  const [includeReplayContent, setIncludeReplayContent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const contentId = useId();
  const saved = useRef<HTMLDivElement>(null);
  const data = plan.data;
  useEffect(() => { if (result) saved.current?.focus(); }, [result]);

  async function save() {
    setBusy(true); setError(null);
    try { setResult(await apiPost<ExportResult>(`/api/reports/${encodeURIComponent(ref)}/export`, { includeContent, includeReplayContent, prepareReview })); }
    catch (reason) { setError(reason instanceof ApiError ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  return (
    <Page current={null} title="Export this report">
      {plan.error ? <LoadError error={plan.error} onRetry={plan.reload} /> : null}
      {plan.loading && !data ? <Loading label="Preparing the export…" rows={2} /> : null}
      {data ? (
        <>
          <PageTitle breadcrumb={[{ label: data.title, to: `/reports/${encodeURIComponent(ref)}` }, { label: 'Export' }]} title="Export this report"
            subtitle={prepareReview ? 'Creates a portable review packet bound to the exported evidence. It saves a Markdown report and JSON sidecar for an external reviewer, without starting an AI review.'
              : 'Saves two files together in one folder: a Markdown report you can read in any text editor, and the JSON file Xenoflux uses to reopen it later, even after the original sessions are gone.'} />
          {info?.mode === 'demo' ? <SimulatedNote>Exporting is simulated; no files are written.</SimulatedNote> : null}
          <div className="flex flex-wrap gap-6 items-start">
            <div className="flex flex-col gap-4" style={{ flex: '999 1 480px' }}>
              <section className="panel flex flex-col gap-2" aria-labelledby="included">
                <h2 id="included" className="text-body font-semibold">Included</h2>
                <ul className="text-ui list-disc pl-5">{data.included.map(item => <li key={item}>{item}</li>)}</ul>
              </section>
              <section className="panel flex flex-col gap-2" aria-labelledby="never">
                <h2 id="never" className="text-body font-semibold">Never included</h2>
                <ul className="text-ui list-disc pl-5">{data.neverIncluded.map(item => <li key={item}>{item}</li>)}</ul>
              </section>
              <section className="panel flex flex-col gap-3" aria-labelledby="optional">
                <h2 id="optional" className="text-body font-semibold">Off unless you choose it</h2>
                {data.contentFiles.length ? (
                  <>
                    <label className="flex gap-3 items-start text-ui">
                      <input type="checkbox" checked={includeContent} onChange={event => setIncludeContent(event.target.checked)} aria-describedby={contentId} disabled={Boolean(result)} />
                      <span><span className="font-medium">Include setup file text</span><br /><span id={contentId} className="muted">Adds the text of changed instructions and skills. Both files follow this choice.</span></span>
                    </label>
                    {includeContent ? (
                      <WarningAlert title={`Adds text from ${data.contentFiles.length} ${data.contentFiles.length === 1 ? 'file' : 'files'}`}>
                        <p className="font-mono wrap-anywhere">{data.contentFiles.join(' · ')}</p>
                        <p>Secret values stay hidden. Read the files and remove anything private before sharing them.</p>
                      </WarningAlert>
                    ) : null}
                  </>
                ) : <p className="hint">This report has no setup file text to add.</p>}
              </section>
              {data.replayAvailable ? <section className="panel flex flex-col gap-3" aria-labelledby="replay-content">
                <h2 id="replay-content" className="text-body font-semibold">Recorded content</h2>
                <label className="flex gap-3 items-start text-ui">
                  <input type="checkbox" checked={includeReplayContent} onChange={event => setIncludeReplayContent(event.target.checked)} disabled={Boolean(result)} aria-describedby={`${contentId}-replay`} />
                  <span><span className="font-medium">Include recorded messages and tool content</span><br /><span id={`${contentId}-replay`} className="muted">Off by default. Includes captured message bodies, tool inputs and results, retained check commands and output, and captured task-end patch text.</span></span>
                </label>
                {includeReplayContent ? <WarningAlert title="Review replay content before sharing">
                  <p>Recorded messages, prompts, tool arguments, check commands, output and file paths may contain private information. Captured content limits and omissions remain visible. Read both exported files before sharing them.</p>
                </WarningAlert> : null}
                {!includeReplayContent ? <p className="hint">Events, relationships, timestamps, source references and content omission states remain in the export.</p> : null}
              </section> : null}
              {prepareReview ? <InfoNotice title="Choose what the reviewer can inspect">
                <p>Event references and evidence metadata remain in the packet. Recorded message and tool content is off by default. Include it only if the reviewer needs those details, then inspect the saved files before sharing.</p>
              </InfoNotice> : null}
              {prepareReview && data.reviewedEvidence ? <InfoNotice title="Existing reviews are bound to their evidence">
                <p>Keep the evidence already reviewed. If this content choice changes it, Xenoflux will refuse the export; prepare a separate packet from the original unreviewed comparison for a different disclosure.</p>
              </InfoNotice> : null}
              <p className="hint">{data.privacy}</p>
            </div>
            <aside className="panel flex flex-col gap-3" style={{ flex: '1 1 320px' }} aria-labelledby="save-to">
              <h2 id="save-to" className="text-body font-semibold">Save to</h2>
              <p className="font-mono text-ui wrap-anywhere">{result?.folder ?? data.folder}</p>
              <ul className="font-mono text-ui list-none p-0">{(result?.files ?? data.files).map(file => <li key={file} className="wrap-anywhere">{file}</li>)}</ul>
              <p className="hint">Keep both files together. The Markdown file starts with the same note.</p>
              {error ? <ErrorPanel title="Not saved">{error}</ErrorPanel> : null}
              {result ? (
                <div ref={saved} tabIndex={-1} className="alert-success flex flex-col gap-2" role="status" aria-label="Report saved">
                  <StatusBadge status="success">Saved</StatusBadge>
                  <p className="text-ui" style={{ color: 'var(--color-text)' }}>Both files are in the folder above. Setup file text: {result.contentIncluded}. Replay content: {result.replayContentIncluded ?? 'not included'}.</p>
                  {result.reviewPacketFingerprint ? <p className="hint">Review packet fingerprint: <span className="font-mono">{result.reviewPacketFingerprint}</span>. The packet matches this exported content choice.</p> : null}
                  <div className="flex flex-wrap gap-2"><CopyButton text={result.folder} label="Copy folder location" />
                    {result.reviewPacketRef ? <Link className="btn btn-primary" to={`/reports/${encodeURIComponent(result.reviewPacketRef)}/reviews`}>Return to this review packet</Link> : <Link className="btn" to={`/reports/${encodeURIComponent(ref)}`}>Back to the report</Link>}</div>
                </div>
              ) : <Button variant="primary" busy={busy} busyLabel="Saving…" onClick={() => void save()}>{prepareReview ? 'Prepare review packet' : 'Export'}</Button>}
            </aside>
          </div>
        </>
      ) : null}
    </Page>
  );
}
