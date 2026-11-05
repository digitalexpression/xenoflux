import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ApiError, apiGet, apiPost } from '@/api/client';
import type { ExecutionSelection, ReviewTaskDecision, ReviewTaskOptions, ReviewTaskPendingRequest, ReviewTaskPreview, ReviewTaskRequest, ReviewTaskStartResponse, ReviewTaskSummary, ReviewTaskView } from '@/api/types';
import { ExecutionFields } from '@/components/ExecutionFields';
import { Disclosure } from '@/components/controls';
import { Loading } from '@/components/layout';
import { ErrorPanel, InfoNotice, SimulatedNote, WarningAlert } from '@/components/notices';
import { Button } from '@/components/ui/button';
import { NativeReviewRequest } from '@/components/NativeReviewRequest';

const terminal = new Set<ReviewTaskView['status']>(['completed', 'failed', 'cancelled', 'interrupted', 'uncertain']);
const labels: Record<ReviewTaskView['status'], string> = {
  prepared: 'Prepared', starting: 'Starting', running: 'Running', 'waiting-for-user': 'Waiting for your response',
  completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted', uncertain: 'Uncertain',
};
const knownPreStartRefusals = new Set(['review-preview-stale', 'review-profile-changed', 'invalid-review-task',
  'review-profile-access-blocked', 'review-profile-access-unavailable', 'review-profile-busy',
  'job-capacity', 'review-workspace-busy', 'run-active', 'review-active', 'review-uncertain', 'review-task-source-mismatch']);

export function ReviewTaskPanel({ refId, title, options, tasks, demo }: {
  refId: string; title: string; options: ReviewTaskOptions; tasks: ReviewTaskSummary[]; demo: boolean;
}) {
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const taskId = search.get('task');
  const taskIdRef = useRef(taskId);
  taskIdRef.current = taskId;
  const refIdRef = useRef(refId);
  refIdRef.current = refId;
  const initialProfile = options.profiles.find(item => item.ready)?.name ?? options.profiles[0]?.name ?? '';
  const [profile, setProfile] = useState(initialProfile);
  const [cwd, setCwd] = useState(options.workspaces.find(item => item.available && (!item.profile || item.profile === initialProfile))?.path ?? '');
  const [execution, setExecution] = useState<ExecutionSelection>({});
  const [prompt, setPrompt] = useState(options.prompt);
  const [includeContent, setIncludeContent] = useState(options.includeRecordedContent);
  const [capped, setCapped] = useState(options.defaults.timeoutMs !== null);
  const [timeoutMs, setTimeoutMs] = useState(options.defaults.timeoutMs ?? 60000);
  const [preview, setPreview] = useState<ReviewTaskPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [task, setTask] = useState<ReviewTaskView | null>(null);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pollRevision, setPollRevision] = useState(0);
  const [unavailableRequests, setUnavailableRequests] = useState<string[]>([]);
  const taskEpoch = useRef(0);
  const loadedTaskId = useRef<string | null>(null);
  const busyRef = useRef(false);
  const pendingStartId = useRef<string | null>(null);
  const mounted = useRef(true);
  const formInitialized = useRef(options.profiles.length > 0);
  const startOutcomeUnknown = useRef(false);
  const formError = useRef<HTMLDivElement>(null);
  const actionErrorSummary = useRef<HTMLDivElement>(null);
  const base = `/api/reports/${encodeURIComponent(refId)}/review-tasks`;
  const setBusyNow = (value: boolean) => { busyRef.current = value; setBusy(value); };
  const inputChanged = () => { setPreview(null); setError(null); };

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (error) formError.current?.focus(); }, [error]);
  useEffect(() => { if (actionError) actionErrorSummary.current?.focus(); }, [actionError]);
  useEffect(() => {
    // Direct task links can load their record before the report's form defaults.
    if (formInitialized.current || !options.profiles.length) return;
    formInitialized.current = true;
    const selected = options.profiles.find(item => item.ready)?.name ?? options.profiles[0]?.name ?? '';
    setProfile(selected); setCwd(options.workspaces.find(item => item.available && (!item.profile || item.profile === selected))?.path ?? '');
    setPrompt(options.prompt); setIncludeContent(options.includeRecordedContent);
    setCapped(options.defaults.timeoutMs !== null); setTimeoutMs(options.defaults.timeoutMs ?? 60000);
  }, [options]);

  const refreshTask = useCallback(async (id: string, epoch = taskEpoch.current) => {
    try {
      const result = await apiGet<ReviewTaskView>(`/api/review-tasks/${encodeURIComponent(id)}`);
      if (!mounted.current || taskIdRef.current !== id || taskEpoch.current !== epoch) return null;
      setTask(result); setTaskError(null);
      if (startOutcomeUnknown.current) { startOutcomeUnknown.current = false; setActionError(null); }
      return result;
    } catch (reason) {
      if (!mounted.current || taskIdRef.current !== id || taskEpoch.current !== epoch) return null;
      setTaskError(reason instanceof ApiError ? reason.message : String(reason));
      return null;
    }
  }, []);

  useEffect(() => {
    const epoch = ++taskEpoch.current;
    if (!taskId) { loadedTaskId.current = null; setTask(null); setTaskError(null); setActionError(null); return; }
    if (pendingStartId.current === taskId) { loadedTaskId.current = taskId; return; }
    if (loadedTaskId.current !== taskId) {
      loadedTaskId.current = taskId; setTask(null); setTaskError(null); setActionError(null); setUnavailableRequests([]);
    }
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      if (!active) return;
      const result = await refreshTask(taskId, epoch);
      if (!active || taskEpoch.current !== epoch) return;
      if (result && !terminal.has(result.status)) timer = window.setTimeout(poll, 1500);
    };
    void poll();
    return () => { active = false; if (timer !== undefined) window.clearTimeout(timer); if (taskEpoch.current === epoch) taskEpoch.current++; };
  }, [taskId, pollRevision, refreshTask]);

  useEffect(() => { setUnavailableRequests([]); }, [taskId]);
  useEffect(() => {
    if (pendingStartId.current !== taskId) { pendingStartId.current = null; setBusyNow(false); }
  }, [taskId]);

  function reconnectTask() {
    if (!taskId || busyRef.current) return;
    setTaskError(null); setActionError(null); setPollRevision(value => value + 1);
  }

  async function prepare(event: React.FormEvent) {
    event.preventDefault();
    if (busyRef.current) return;
    setBusyNow(true); setError(null);
    const sourceRef = refId;
    const request: ReviewTaskRequest = { profile, execution, ...(cwd ? { cwd } : {}), prompt, includeRecordedContent: includeContent, timeoutMs: capped ? timeoutMs : null };
    try {
      const result = await apiPost<ReviewTaskPreview>(`${base}/preview`, request);
      if (mounted.current && refIdRef.current === sourceRef) setPreview(result);
    } catch (reason) { if (mounted.current && refIdRef.current === sourceRef) setError(reason instanceof ApiError ? reason.message : String(reason)); }
    finally { if (mounted.current) setBusyNow(false); }
  }

  async function start() {
    if (!preview?.ready || !preview.previewToken || busyRef.current) return;
    const token = preview.previewToken;
    setBusyNow(true); setError(null); setActionError(null); pendingStartId.current = token;
    setTask(null); setTaskError(null); setSearch({ task: token }, { replace: true });
    try {
      const started = await apiPost<ReviewTaskStartResponse>(base, { previewToken: token });
      if (!mounted.current || pendingStartId.current !== token || taskIdRef.current !== token) return;
      pendingStartId.current = null;
      window.dispatchEvent(new Event('xenoflux-info-changed'));
      setPreview(null);
      setPollRevision(value => value + 1);
      navigate(`/reports/r.${encodeURIComponent(started.id)}/reviews?task=${encodeURIComponent(started.id)}`, { replace: true });
    } catch (reason) {
      if (!mounted.current || pendingStartId.current !== token || taskIdRef.current !== token) return;
      pendingStartId.current = null;
      const message = reason instanceof ApiError ? reason.message : String(reason);
      if (reason instanceof ApiError && knownPreStartRefusals.has(reason.code)) {
        setSearch({}, { replace: true }); setTask(null); setTaskError(null); setPreview(null); setError(message);
      } else {
        startOutcomeUnknown.current = true;
        setActionError(`${message} The start outcome is unknown. The task ID remains in the URL; reconnect to check it. No automatic retry was sent.`);
        setPollRevision(value => value + 1);
      }
    } finally { if (mounted.current && taskIdRef.current === token) setBusyNow(false); }
  }

  async function cancel() {
    if (!taskId || busyRef.current || !task || terminal.has(task.status)) return;
    const epoch = ++taskEpoch.current;
    setBusyNow(true); setActionError(null);
    try { await apiPost(`/api/review-tasks/${encodeURIComponent(taskId)}/cancel`); }
    catch (reason) { if (taskIdRef.current === taskId && taskEpoch.current === epoch) setActionError(reason instanceof ApiError ? reason.message : String(reason)); }
    finally { if (taskIdRef.current === taskId && taskEpoch.current === epoch) { setBusyNow(false); setPollRevision(value => value + 1); } }
  }

  async function respond(request: ReviewTaskPendingRequest, response: ReviewTaskDecision) {
    if (!taskId || busyRef.current) return;
    const epoch = ++taskEpoch.current;
    setBusyNow(true); setActionError(null);
    try {
      await apiPost(`/api/review-tasks/${encodeURIComponent(taskId)}/requests/${encodeURIComponent(request.requestId)}`, { response });
    } catch (reason) {
      if (taskIdRef.current === taskId && taskEpoch.current === epoch) {
        setActionError(reason instanceof ApiError ? reason.message : String(reason));
        if (reason instanceof ApiError && reason.code === 'stale-review-request') setUnavailableRequests(ids => [...new Set([...ids, request.requestId])]);
      }
    } finally { if (taskIdRef.current === taskId && taskEpoch.current === epoch) { setBusyNow(false); setPollRevision(value => value + 1); } }
  }

  if (taskId) return <section className="panel flex flex-col gap-3 min-w-0 wrap-anywhere" aria-labelledby="review-task-state">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 id="review-task-state" className="text-heading">Review task</h2>
      {task ? <span className="meta" role="status" aria-live="polite">{labels[task.status]}</span> : null}
    </div>
    {taskError ? <ErrorPanel title="Review task unavailable" actions={<Button variant="secondary" disabled={busy} onClick={reconnectTask}>Retry connection</Button>}>{taskError}</ErrorPanel> : null}
    {actionError ? <div ref={actionErrorSummary} tabIndex={-1}><ErrorPanel title="Review task action failed">{actionError}</ErrorPanel></div> : null}
    {!task && !taskError ? <Loading label={pendingStartId.current === taskId ? 'Starting review…' : 'Reconnecting to review task…'} /> : null}
    {task ? <>
      <p className="text-ui">{task.title} · profile <span className="font-medium">{task.profile}</span></p>
      <p className="hint">Working directory: <span className="font-mono">{task.cwd || 'Unavailable'}</span></p>
      <p className="hint">{task.threadId ? 'Native session recorded; its identifiers are available in task details.' : 'Native session identity has not been recorded.'}</p>
      <p className="hint">This task remains associated with the frozen comparison. <Link className="link" to={`/reports/${encodeURIComponent(task.reportRef)}`}>Open its comparison and evidence</Link></p>
      {task.pendingRequests.length && task.status !== 'waiting-for-user' ? <InfoNotice title="Native request unavailable"><p>The saved request is not waiting in a live native session and cannot be replayed.</p></InfoNotice> : null}
      {task.pendingRequests.filter(request => task.status === 'waiting-for-user' && !unavailableRequests.includes(request.requestId)).map(request => <NativeReviewRequest key={request.requestId} request={request} busy={busy} onRespond={(response: ReviewTaskDecision) => respond(request, response)} />)}
      {unavailableRequests.length ? <InfoNotice title="Native request unavailable"><p>This request is no longer active. No response was submitted; it cannot be replayed.</p></InfoNotice> : null}
      {task.response ? <section className="rounded-control p-3 flex flex-col gap-2" aria-labelledby="review-task-response" style={{ border: '1px solid var(--color-divider)' }}>
        <h3 id="review-task-response" className="text-body font-semibold">{task.response.status === 'complete' ? 'Captured response' : task.response.status === 'partial' ? 'Partial response' : 'Response unavailable'}</h3>
        {task.response.text ? <div className="text-ui whitespace-pre-wrap break-words">{task.response.text}</div> : <p className="text-ui">No response text was captured.</p>}
        <p className="hint">Natural-language output is shown as captured; it does not create ratings or a verdict.</p>
      </section> : null}
      {task.error ? <ErrorPanel title="Review task did not complete">{task.error}</ErrorPanel> : null}
      <p className="hint">Requested model {task.execution?.model ?? 'profile default'} · effort {task.execution?.reasoningEffort ?? 'profile default'}</p>
      {task.nativeSettings ? <InfoNotice title="Native settings reported"><p>These values were reported by the native session. They do not independently prove which provider settings took effect.</p></InfoNotice>
        : <InfoNotice title="Native settings unknown"><p>The task record does not establish the settings or provider used.</p></InfoNotice>}
      {task.threadId || task.nativeSettings || task.shutdown ? <Disclosure label="Show task technical details" expandedLabel="Hide task technical details"><div className="font-mono text-ui whitespace-pre-wrap wrap-anywhere">{JSON.stringify({ threadId: task.threadId, turnId: task.turnId, responseThreadId: task.response?.threadId ?? null, responseTurnId: task.response?.turnId ?? null, requestedExecution: task.execution, nativeSettings: task.nativeSettings, sourceEvidenceFingerprint: task.sourceEvidenceFingerprint, inputFingerprint: task.inputFingerprint, promptSha256: task.promptSha256, includeRecordedContent: task.includeRecordedContent, shutdown: task.shutdown }, null, 2)}</div></Disclosure> : null}
      {task.frozenPrompt ? <Disclosure label="Show frozen review prompt" expandedLabel="Hide frozen review prompt">
        <pre className="font-mono text-ui whitespace-pre-wrap wrap-anywhere">{task.frozenPrompt}</pre>
      </Disclosure> : null}
      {task.nativeSettings && Object.entries(task.nativeSettings).filter(([key, value]) => /model|provider|effort/i.test(key) && (typeof value === 'string' || typeof value === 'number')).map(([key, value]) => <p className="hint" key={key}>{key}: <span className="font-mono">{String(value)}</span> (reported by native session)</p>)}
      {task.limits.map(limit => <p className="hint" key={limit}>{limit}</p>)}
      {task.shutdown ? <InfoNotice title="Native process shutdown"><p>Status: {task.shutdown.status}{task.shutdown.groupTerminated ? ' · process group terminated' : ' · process-group shutdown is not confirmed'}</p></InfoNotice> : null}
      {!task.shutdown && terminal.has(task.status) ? <InfoNotice title="Native process shutdown unknown"><p>The saved task does not contain a shutdown result. A captured response does not establish whether the native process stopped cleanly.</p></InfoNotice> : null}
      {demo ? <SimulatedNote>Demo task result is simulated; no model task starts.</SimulatedNote> : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" disabled={busy} onClick={reconnectTask}>{task ? 'Refresh task' : 'Retry task connection'}</Button>
        {task && !terminal.has(task.status) ? <Button variant="secondary" busy={busy} busyLabel="Cancelling…" onClick={() => void cancel()}>Cancel review</Button> : null}
      </div>
    </> : null}
    {task?.sourceRef && task.sourceRef !== refId ? <Link className="btn self-start" to={`/reports/${encodeURIComponent(task.sourceRef)}/reviews`}>Open source report reviews</Link> : null}
    <Button variant="secondary" disabled={busy} onClick={() => { setPreview(null); setSearch({}); setTask(null); }}>Return to review form</Button>
  </section>;

  if (!options.profiles.length) return <section className="panel flex flex-col gap-3" aria-labelledby="start-review"><h2 id="start-review" className="text-heading">Review this comparison</h2><WarningAlert title="No profiles available">Configure a profile before starting an ordinary review task.</WarningAlert></section>;
  return <section className="panel flex flex-col gap-3 min-w-0 wrap-anywhere" aria-labelledby="start-review">
    <h2 id="start-review" className="text-heading">Review this comparison</h2>
    <p className="text-ui">Choose a profile and its normal workspace, inspect the prompt and retained report content, then preview the exact inputs. No model starts until you select Start review.</p>
    {demo ? <SimulatedNote>The demo uses this same form and shows a simulated review result. No model task starts.</SimulatedNote> : null}
    <form className="flex flex-col gap-3" onSubmit={prepare}>
      <div><label htmlFor="review-profile" className="field-label">Profile</label><select id="review-profile" className="input font-mono" value={profile} disabled={busy} onChange={event => { const next = event.target.value; setProfile(next); setCwd(options.workspaces.find(item => item.available && (!item.profile || item.profile === next))?.path ?? ''); inputChanged(); }}>
        {options.profiles.map(item => <option key={item.name} value={item.name}>{item.name}{item.ready ? '' : ` · ${item.readiness}`}</option>)}
      </select></div>
      <div><label htmlFor="review-cwd" className="field-label">Workspace</label><select id="review-cwd" className="input font-mono" value={cwd} disabled={busy} onChange={event => { setCwd(event.target.value); inputChanged(); }}>
        <option value="">Profile default workspace</option>{options.workspaces.filter(item => !item.profile || item.profile === profile).map(item => <option key={`${item.profile ?? ''}:${item.path}`} value={item.path} disabled={!item.available}>{item.path}{item.available ? '' : ' · unavailable'}</option>)}
      </select></div>
      <p className="hint">Choose a separate workspace for each simultaneous review.</p>
      <ExecutionFields value={execution} disabled={busy} onChange={value => { setExecution(value); inputChanged(); }} />
      <div><label htmlFor="review-prompt" className="field-label">Review prompt</label><textarea id="review-prompt" className="input" rows={6} value={prompt} disabled={busy} onChange={event => { setPrompt(event.target.value); inputChanged(); }} /></div>
      <label className="flex gap-2 items-start text-ui"><input type="checkbox" checked={includeContent} disabled={busy} onChange={event => { setIncludeContent(event.target.checked); inputChanged(); }} />Include recorded report content</label>
      <fieldset className="flex flex-col gap-2"><legend className="field-label">Model turn time limit</legend>
        <label className="flex gap-2 items-center text-ui"><input type="radio" name="review-time-cap" checked={!capped} disabled={busy} onChange={() => { setCapped(false); inputChanged(); }} />No time cap (default)</label>
        <label className="flex flex-wrap gap-2 items-center text-ui"><input type="radio" name="review-time-cap" checked={capped} disabled={busy} onChange={() => { setCapped(true); inputChanged(); }} />Limit to <input aria-label="Time limit in minutes" className="input w-24" type="number" min={1} max={1440} value={Math.max(1, Math.round(timeoutMs / 60000))} onChange={event => { setTimeoutMs(Math.max(60000, Number(event.target.value) * 60000)); setCapped(true); inputChanged(); }} disabled={!capped || busy} /> minutes</label>
      </fieldset>
      {error ? <div ref={formError} tabIndex={-1}><ErrorPanel title="Review could not start">{error}</ErrorPanel></div> : null}
      <Button type="submit" busy={busy} busyLabel="Preparing…" disabled={!profile || !prompt.trim()}>Preview review</Button>
    </form>
    {preview ? <section className="rounded-control p-4 flex flex-col gap-3" role="region" aria-label="Review task preview" style={{ border: '1px solid var(--color-divider)' }}>
      <h3 className="text-body font-semibold">Review preview · {preview.title}</h3>
      {!preview.ready ? <WarningAlert title={preview.blocked?.title ?? 'Review is not ready'}>{preview.blocked?.reason ?? 'Resolve the reported issue before starting.'}</WarningAlert> : null}
      <InfoNotice title="Exact task inputs">
        <p>Source comparison: {title} · report reference <span className="font-mono">{refId}</span></p>
        <p>Profile: <span className="font-mono">{preview.profile}</span></p>
        <p>Working directory: <span className="font-mono break-all">{preview.cwd}</span></p>
        <p>Executable: <span className="font-mono">{preview.executable}</span></p>
        <p>Requested model {preview.model ?? 'profile default'} · reasoning effort {preview.reasoningEffort ?? 'profile default'}</p>
        <p>Model turn limit: {preview.timeoutMs === null ? 'uncapped' : `${Math.ceil(preview.timeoutMs / 60000)} minutes`}</p>
        <p>Recorded content: {preview.contentChoice}</p>
        <p>{preview.summary}</p>
        <p>Effective prompt (sent unchanged):</p><pre className="font-mono text-ui whitespace-pre-wrap break-words">{preview.effectivePrompt}</pre>
      </InfoNotice>
      <InfoNotice title="Scope and limits">
        <p>The task uses normal native history and runtime behavior. The prompt refers to this report; it does not isolate the session from other files or local tools.</p>
        <p>Redacting recorded session content does not remove private prose or code from report files that are included.</p>
        {preview.willDo.map(item => <p key={item}>{item}</p>)}{preview.never.map(item => <p key={item}>{item}</p>)}{preview.limits.map(item => <p key={item}>{item}</p>)}
      </InfoNotice>
      <div><h4 className="text-ui font-semibold">Input files</h4>{preview.inputs.map(file => <div className="text-ui" key={file.name}><p className="m-0">{file.name}</p><p className="hint break-all">Location: {file.path}</p><Disclosure label="Show file size and SHA-256" expandedLabel="Hide file details"><p className="font-mono text-ui">{file.bytes} bytes · SHA-256 {file.sha256}</p></Disclosure></div>)}</div>
      <div className="flex flex-wrap gap-2"><Button variant="primary" busy={busy} busyLabel="Starting…" disabled={!preview.ready || !preview.previewToken} onClick={() => void start()}>Start review</Button>
        <Button variant="secondary" disabled={busy} onClick={() => { setPreview(null); }}>Edit review</Button></div>
    </section> : null}
    {tasks.length ? <section className="flex flex-col gap-2" aria-labelledby="prior-review-tasks"><h3 id="prior-review-tasks" className="text-body font-semibold">Ordinary review tasks</h3>
      {tasks.map(item => <div key={item.id} className="flex flex-wrap gap-2 items-center justify-between rounded-control p-3" style={{ border: '1px solid var(--color-divider)' }}>
        <div className="min-w-0"><p className="text-ui m-0">{item.profile} · {labels[item.status]}</p><p className="hint">{item.createdAt}</p>
          {item.execution ? <p className="hint">Requested {item.execution.model ?? 'profile default'} · effort {item.execution.reasoningEffort ?? 'profile default'}</p> : null}
          {item.observedModel || item.observedEffort ? <p className="hint">Reported {item.observedModel ?? 'unknown model'} · effort {item.observedEffort ?? 'unknown'}</p> : null}
          <p className="text-ui m-0">{item.summary}</p></div><Button variant="secondary" aria-label={`Open review by ${item.profile} from ${item.createdAt}`} onClick={() => navigate(`/reports/r.${encodeURIComponent(item.id)}/reviews?task=${encodeURIComponent(item.id)}`)}>Open task</Button>
      </div>)}
    </section> : null}
  </section>;
}
