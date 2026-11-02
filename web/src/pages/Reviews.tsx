import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ApiError, apiGet, apiPost } from '@/api/client';
import type { ReviewPreviewView, ReviewsView, SavedReviewView } from '@/api/types';
import { StatusBadge, TagPill, VerdictBadge } from '@/components/badges';
import { Disclosure } from '@/components/controls';
import { Loading, LoadError, Page, PageTitle, useInfo } from '@/components/layout';
import { ErrorPanel, InfoNotice } from '@/components/notices';
import { Button } from '@/components/ui/button';
import { ReviewTaskPanel } from '@/components/ReviewTaskPanel';
import { useResource } from '@/lib/useResource';

/** Retained review display and explicit import of externally prepared submissions. */
export function Reviews() {
  const { ref = '' } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const taskId = searchParams.get('task');
  const info = useInfo();
  const view = useResource(() => apiGet<ReviewsView>(`/api/reports/${encodeURIComponent(ref)}/reviews`), ref);
  const data = view.data?.ref === ref ? view.data : undefined;
  const [submission, setSubmission] = useState<unknown>(null);
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<ReviewPreviewView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importRef, setImportRef] = useState(ref);
  const fileReadGeneration = useRef(0);
  const importStateCurrent = importRef === ref;
  const activeSubmission = importStateCurrent ? submission : null;
  const activeFileName = importStateCurrent ? fileName : '';
  const activePreview = importStateCurrent ? preview : null;
  const activeLoading = importStateCurrent && loading;
  const activeError = importStateCurrent ? error : null;
  const base = `/reports/${encodeURIComponent(ref)}`;

  useEffect(() => {
    fileReadGeneration.current++;
    setImportRef(ref);
    setSubmission(null); setFileName(''); setPreview(null); setLoading(false); setError(null);
  }, [ref]);

  async function chooseFile(file?: File) {
    const generation = ++fileReadGeneration.current;
    setImportRef(ref);
    setPreview(null); setSubmission(null); setError(null); setFileName(file?.name ?? '');
    if (!file) return;
    if (file.size > 1 << 20) { setError('Review files must be no larger than 1 MiB.'); return; }
    try {
      const text = await file.text();
      if (generation !== fileReadGeneration.current) return;
      let value: unknown;
      try { value = JSON.parse(text); }
      catch { throw new Error('Could not read this file as JSON. Check that it is a valid review submission.'); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose a JSON review submission object.');
      setSubmission(value);
    } catch (reason) {
      if (generation === fileReadGeneration.current) {
        const message = reason instanceof Error && [
          'Could not read this file as JSON. Check that it is a valid review submission.',
          'Choose a JSON review submission object.',
        ].includes(reason.message) ? reason.message : 'Could not read this review file.';
        setError(message);
      }
    }
  }

  async function prepare() {
    if (!activeSubmission) return;
    const generation = fileReadGeneration.current, sourceRef = ref;
    setLoading(true); setError(null);
    try {
      const result = await apiPost<ReviewPreviewView>(`/api${base}/reviews/preview`, { submission: activeSubmission });
      if (sourceRef === ref && generation === fileReadGeneration.current) setPreview(result);
    } catch (reason) {
      if (sourceRef === ref && generation === fileReadGeneration.current) setError(reason instanceof ApiError ? reason.message : String(reason));
    } finally { if (sourceRef === ref && generation === fileReadGeneration.current) setLoading(false); }
  }

  async function save() {
    if (!activePreview) return;
    const generation = fileReadGeneration.current, sourceRef = ref;
    setLoading(true); setError(null);
    try {
      const saved = await apiPost<SavedReviewView>(`/api${base}/reviews`, { token: activePreview.token });
      if (sourceRef === ref && generation === fileReadGeneration.current)
        navigate(`/reports/${encodeURIComponent(saved.ref)}/reviews`);
    } catch (reason) { if (sourceRef === ref && generation === fileReadGeneration.current) setError(reason instanceof ApiError ? reason.message : String(reason)); }
    finally { if (sourceRef === ref && generation === fileReadGeneration.current) setLoading(false); }
  }

  return (
    <Page current="compare" title="Reviews" reading>
      {view.error ? <LoadError error={view.error} onRetry={view.reload} /> : null}
      {view.loading && !data ? <Loading label="Reading reviews…" /> : null}
      {taskId ? <PageTitle breadcrumb={data ? [{ label: 'Compare', to: '/' }, { label: data.title, to: `/reports/${encodeURIComponent(ref)}` }, { label: 'Reviews' }] : undefined}
        title="Reviews" subtitle="Reconnect to the saved review task and its frozen comparison." /> : data ? <PageTitle breadcrumb={[{ label: 'Compare', to: '/' }, { label: data.title, to: base }, { label: 'Reviews' }]} title="Reviews"
          actions={<Link className="btn btn-primary" to={`${base}/export`}>Export report</Link>}
          subtitle="Reviews are attributed annotations tied to this report’s frozen evidence. Xenoflux never judges results itself or fills in ratings." /> : null}
      {data?.reviewOptions || taskId ? <ReviewTaskPanel key={ref} refId={ref} title={data?.title ?? 'Review task'}
        options={data?.reviewOptions ?? { profiles: [], workspaces: [], prompt: '', includeRecordedContent: false, defaults: { timeoutMs: null } }}
        tasks={data?.reviewTasks ?? []} demo={info?.mode === 'demo'} /> : null}
      {data && !taskId ? (
        <>
          {data.canPrepare && info?.mode !== 'demo' ? <section className="panel flex flex-col gap-3" aria-labelledby="prepare-review">
            <h2 id="prepare-review" className="text-heading">Prepare an external review</h2>
            <p className="text-ui">Choose the exact report content to share. The packet’s evidence fingerprint is calculated after that choice, so an imported review stays bound to what the reviewer received.</p>
            <div><Link className="btn btn-secondary" to={`${base}/export?review=1`}>Prepare packet for external review</Link></div>
          </section> : null}
          {data.canImport && info?.mode !== 'demo' ? (
            <section className="panel flex flex-col gap-3" aria-labelledby="attach-review">
              <h2 id="attach-review" className="text-heading">Attach a review</h2>
              <p className="text-ui">Import a review submission prepared by a person or an external AI reviewer. This import path does not send evidence to an AI service. The file is checked against this report’s evidence and saved as a new immutable evaluation. Review the exported packet before sharing it; recorded content may contain private information.</p>
              {data.hasReviews ? <InfoNotice title="Keep earlier review evidence intact">
                <p>Reviews remain bound to the content the reviewers received. If a different recorded-content disclosure is required, prepare a separate packet from the original unreviewed comparison; Xenoflux preserves this review history and will refuse an export that changes its evidence.</p>
              </InfoNotice> : null}
              <label className="flex flex-col gap-2 text-ui" htmlFor="review-file">
                <span className="font-medium">Review submission JSON</span>
                <input key={ref} id="review-file" type="file" accept="application/json,.json" onChange={event => void chooseFile(event.target.files?.[0])} disabled={activeLoading} />
              </label>
              {activeFileName ? <p className="hint">Selected: {activeFileName}</p> : null}
              {activeError ? <ErrorPanel title={activePreview ? 'Review not saved' : 'Review not prepared'}>{activeError}</ErrorPanel> : null}
              {activeSubmission && !activePreview ? <Button busy={activeLoading} busyLabel="Checking…" onClick={() => void prepare()}>Preview imported review</Button> : null}
              {activePreview ? <div className="flex flex-col gap-3" role="region" aria-label="Review preview">
                <InfoNotice title="Bound to this report">
                  <p>Evidence fingerprint: <span className="font-mono">{activePreview.evidenceFingerprint}</span></p>
                  <p>Allowed scope: {activePreview.claimScopes.join(' · ')}</p>
                  <p>{activePreview.evidenceRefCount} frozen evidence references are available. Consistency: {activePreview.consistency}</p>
                </InfoNotice>
                {activePreview.topics.map(topic => (
                  <section className="rounded-control p-4 flex flex-col gap-2" style={{ border: '1px solid var(--color-divider)' }} key={topic.title}>
                    <h3 className="text-body font-semibold">{topic.title}</h3>
                    {topic.disagreement ? <InfoNotice>{topic.disagreement}</InfoNotice> : null}
                    {topic.reviews.map((review, index) => <article className="flex flex-col gap-2" key={`${review.reviewer}-${index}`}>
                      <div className="flex flex-wrap items-center gap-2"><TagPill>{review.kind === 'human' ? 'Person' : 'AI agent'}</TagPill><span className="font-medium wrap-anywhere">{review.reviewer}</span></div>
                      <div className="flex flex-wrap items-center gap-2"><VerdictBadge verdict={review.verdict} /><span className="text-ui">prefers {review.prefers}</span></div>
                      <blockquote className="text-ui m-0">“{review.quote}”</blockquote>
                      <p className="text-ui"><span className="muted">Cites: </span>{review.basedOn.map((item, i) => <span key={i}>{i ? ' · ' : ''}{item.href ? <Link to={item.href}>{item.text}</Link> : item.text}</span>)}</p>
                    </article>)}
                  </section>
                ))}
                <div className="flex flex-wrap gap-2"><Button busy={activeLoading} busyLabel="Saving…" onClick={() => void save()}>Save review</Button>
                  <Button variant="secondary" disabled={activeLoading} onClick={() => { fileReadGeneration.current++; setPreview(null); setSubmission(null); setFileName(''); setError(null); }}>Choose another file</Button></div>
              </div> : null}
            </section>
          ) : null}
          {data.topics.map(topic => (
            <section key={topic.title} className="panel flex flex-col gap-3" aria-labelledby={`topic-${topic.title}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 id={`topic-${topic.title}`} className="text-heading">{topic.title}</h2>
                {topic.notReviewed ? <StatusBadge status="neutral">Not reviewed</StatusBadge> : <span className="meta">{topic.meta}</span>}
              </div>
              {topic.disagreement ? <InfoNotice>{topic.disagreement}</InfoNotice> : null}
              <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))' }}>
                {topic.reviews.map((review, index) => (
                  <article key={index} className="rounded-control p-4 flex flex-col gap-2" style={{ border: '1px solid var(--color-divider)' }}>
                    <div className="flex flex-wrap items-center gap-2"><TagPill>{review.kind === 'human' ? 'Person' : 'AI agent'}</TagPill><span className="font-medium wrap-anywhere">{review.reviewer}</span></div>
                    <div className="flex flex-wrap items-center gap-2"><VerdictBadge verdict={review.verdict} /><span className="text-ui">prefers {review.prefers}</span></div>
                    <blockquote className="text-ui m-0">“{review.quote}”</blockquote>
                    <p className="text-ui"><span className="muted">Based on: </span>{review.basedOn.map((item, i) => (
                      <span key={i}>{i ? ' · ' : ''}{item.href ? <Link to={item.href}>{item.text}</Link> : item.text}</span>))}</p>
                    <p className="meta">{review.date}</p>
                    {review.earlier ? (
                      <Disclosure label="Show earlier version" expandedLabel="Hide earlier version">
                        <div className="text-ui flex flex-col gap-1"><span className="font-medium">Earlier version · replaced</span>
                          <span>Verdict: {review.earlier.verdict} · “{review.earlier.quote}”</span><span className="meta">{review.earlier.date}</span></div>
                      </Disclosure>
                    ) : null}
                    {review.kind === 'ai' ? <p className="hint">AI reviews stay labelled as AI and never count as a person’s rating.</p> : null}
                  </article>
                ))}
              </div>
            </section>
          ))}
          <section className="panel flex flex-col gap-2" aria-labelledby="repeat">
            <h2 id="repeat" className="text-heading">Whether differences repeat</h2>
            <p className="text-ui">{data.consistency}</p>
          </section>
          {data.checksAfter.length ? (
            <section className="panel flex flex-col gap-2" aria-labelledby="checks-after">
              <h2 id="checks-after" className="text-heading">Checks run afterwards</h2>
              <p className="hint">Kept separate from checks run during the task.</p>
              {data.checksAfter.map(check => <p key={check.text} className="text-ui flex flex-wrap gap-2 items-center"><StatusBadge status={check.status}>{check.text}</StatusBadge><span className="hint">{check.by}</span></p>)}
            </section>
          ) : null}
          {info?.mode === 'demo' ? <p className="hint">Review import is not simulated in the demo.</p> : data.canImport ? null
            : data.canPrepare ? <p className="hint">Open the saved review packet to import a submission bound to that exported evidence.</p> : null}
        </>
      ) : null}
    </Page>
  );
}
