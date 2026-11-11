import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeftRight } from 'lucide-react';
import { ApiError, apiGet, apiPost } from '@/api/client';
import type { ReviewTaskDecision, RunAdvanced, RunOptions, RunProfileOption, RunPreview, RunRequest, RunView } from '@/api/types';
import { ExecutionFields } from '@/components/ExecutionFields';
import { NativeReviewRequest } from '@/components/NativeReviewRequest';
import { StatusBadge } from '@/components/badges';
import { Loading, LoadError, Page, PageTitle, useInfo } from '@/components/layout';
import { ErrorPanel, InfoNotice, SimulatedNote, WarningAlert } from '@/components/notices';
import { ProfileChip, SideText } from '@/components/profile';
import { Button } from '@/components/ui/button';
import { useResource } from '@/lib/useResource';
import { cn } from '@/lib/cn';

const DRAFT = 'xenoflux-run-draft';
const optionKey = (profile: Pick<RunProfileOption, 'client' | 'name'>) => profile.client ? `${profile.client}:${profile.name}` : profile.name;
function notifyInfoChanged() { window.dispatchEvent(new Event('xenoflux-info-changed')); }
function loadDraft(): RunRequest | null {
  try { const value = sessionStorage.getItem(DRAFT); return value ? JSON.parse(value) as RunRequest : null; } catch { return null; }
}
function saveDraft(request: RunRequest) { try { sessionStorage.setItem(DRAFT, JSON.stringify(request)); } catch { /* the draft is a convenience only */ } }

function NotInThisBuild() {
  return (
    <Page current="compare" title="Run a new task">
      <PageTitle title="Run a new task" />
      <InfoNotice title="Not available in this build yet">Running a new task from the app comes in a later build. Use <span className="font-mono">xfx audit run</span> in the meantime, or compare sessions you already have.</InfoNotice>
      <div><Link className="btn" to="/compare/sessions">Use existing sessions</Link></div>
    </Page>
  );
}

export function RunNew() {
  const info = useInfo();
  if (!info?.features.runs) return <NotInThisBuild />;
  return <RunForm />;
}

function RunForm() {
  const navigate = useNavigate();
  const options = useResource(() => apiGet<RunOptions>('/api/runs/new'), 'run-options');
  const draft = loadDraft();
  const [task, setTask] = useState(draft?.task ?? '');
  const [files, setFiles] = useState(draft?.files ?? '');
  const [a, setA] = useState(draft?.a ? optionKey({ name: draft.a, client: draft.clients?.a }) : '');
  const [b, setB] = useState(draft?.b ? optionKey({ name: draft.b, client: draft.clients?.b }) : '');
  const inherited = { reasoningEffort: draft?.advanced?.reasoningEffort || undefined };
  const [execution, setExecution] = useState(draft?.execution ?? { a: inherited, b: inherited });
  const [repository, setRepository] = useState(draft?.repository ?? '');
  const [commit, setCommit] = useState(draft?.commit ?? '');
  const [checks, setChecks] = useState(draft?.checks ?? []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [advanced, setAdvanced] = useState<RunAdvanced | null>(() => {
    if (!draft?.advanced) return null;
    const { timeMinutes, outputMiB, program, setup, reasoningEffort } = draft.advanced;
    return { timeMinutes, outputMiB, program, setup, reasoningEffort };
  });
  const [error, setError] = useState<string | null>(null);
  const [taskError, setTaskError] = useState(false);
  const ids = { task: useId(), files: useId(), a: useId(), b: useId(), repo: useId(), commit: useId(), taskError: useId(), advanced: useId(), repos: useId() };
  const data = options.data;
  useEffect(() => {
    if (!data) return;
    const ready = data.profiles.filter(p => p.ready).map(optionKey);
    setA(current => current || ready[0] || '');
    setB(current => current || ready[1] || ready[0] || '');
    if (!repository && data.repositories[0]) { setRepository(data.repositories[0].path); setCommit(data.repositories[0].commit); }
  }, [data]);

  const note = (name: string) => data?.profiles.find(p => optionKey(p) === name);
  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!task.trim()) { setTaskError(true); document.getElementById(ids.task)?.focus(); return; }
    const left = note(a), right = note(b);
    const clients = { a: left?.client, b: right?.client };
    const request: RunRequest = { task, files, a: left?.name ?? a, b: right?.name ?? b,
      ...(clients.a || clients.b ? { clients } : {}), repository, commit, checks, execution, ...(advanced ? { advanced } : {}) };
    saveDraft(request);
    navigate('/runs/new/review', { state: request });
  }
  const cap = data?.defaults;
  return (
    <Page current="compare" title="Run a new task">
      <PageTitle breadcrumb={[{ label: 'Compare', to: '/' }, { label: 'Compare a task' }, { label: 'Run a new task' }]} title="Run a new task"
        subtitle="The task runs on two sides, one after the other. Both sides can use the same profile. Nothing starts until you review it on the next step." />
      {data?.simulated ? <SimulatedNote>Runs are simulated; no model task starts and no files are copied.</SimulatedNote> : null}
      {options.error ? <LoadError error={options.error} onRetry={options.reload} /> : null}
      {options.loading && !data ? <Loading label="Checking profiles and projects…" /> : null}
      {data ? (
        <form className="flex flex-wrap gap-6 items-start" onSubmit={submit} noValidate>
          <div className="flex flex-col gap-6" style={{ flex: '999 1 600px', minWidth: 0 }}>
            <section className="panel flex flex-col gap-3" aria-labelledby="task-heading">
              <h2 id="task-heading" className="text-heading">Task</h2>
              <div>
                <label htmlFor={ids.task} className="field-label">What should both profiles do?</label>
                <textarea id={ids.task} className="input" rows={4} value={task} onChange={event => { setTask(event.target.value); setTaskError(false); }}
                  aria-invalid={taskError || undefined} aria-describedby={`${ids.task}-hint${taskError ? ` ${ids.taskError}` : ''}`} />
                {taskError ? <p id={ids.taskError} className="text-ui mt-1" style={{ color: 'var(--color-error)' }}>Describe the task both profiles should do.</p> : null}
                <p id={`${ids.task}-hint`} className="hint mt-1">Sent unchanged to both profiles. Kept private; reports don’t include the text.</p>
              </div>
              <div>
                <label htmlFor={ids.files} className="field-label">Files it may change <span className="muted font-normal">(optional)</span></label>
                <input id={ids.files} className="input font-mono" value={files} onChange={event => setFiles(event.target.value)} aria-describedby={`${ids.files}-hint`} />
                <p id={`${ids.files}-hint`} className="hint mt-1">Used to point out edits to other files. It doesn’t block them.</p>
              </div>
            </section>
            <section className="panel flex flex-col gap-3" aria-labelledby="profiles-heading">
              <h2 id="profiles-heading" className="text-heading">Comparison sides</h2>
              <div className="flex flex-wrap gap-4 items-end">
                {(['a', 'b'] as const).flatMap(side => {
                  const value = side === 'a' ? a : b;
                  const set = side === 'a' ? setA : setB;
                  const readiness = note(value);
                  const slot = (
                    <div key={side} className={cn('flex-1 min-w-[220px] rounded-control p-3 flex flex-col gap-1', side === 'a' ? 'edge-a' : 'edge-b')}>
                      <label htmlFor={side === 'a' ? ids.a : ids.b} className="field-label"><SideText side={side}>{side === 'a' ? 'First' : 'Second'}</SideText> · {side === 'a' ? 'left' : 'right'} side of the report</label>
                  <select id={side === 'a' ? ids.a : ids.b} className="input font-mono" value={value} onChange={event => { set(event.target.value); setExecution(current => ({ ...current, [side]: {} })); }}>
                    <option value="">Choose a profile</option>
                        {data.profiles.map(p => <option key={optionKey(p)} value={optionKey(p)}>{p.label ?? p.name}</option>)}
                      </select>
                      <ExecutionFields profile={readiness?.name ?? value} client={readiness?.client} workspace={repository} value={execution[side]} onChange={value => setExecution(old => ({ ...old, [side]: value }))} />
                      {readiness ? <span className="text-ui" style={{ color: readiness.ready ? 'var(--color-text-muted)' : 'var(--color-warning)' }}>{[readiness.surface?.toUpperCase(), readiness.rootMode ? readiness.rootMode + ' root' : null, readiness.executionLocation, readiness.readiness].filter(Boolean).join(' · ')}</span> : null}
                    </div>
                  );
                  return side === 'a' ? [slot, <Button key="swap" size="icon" aria-label="Swap the two sides" onClick={() => { setA(b); setB(a); setExecution({ a: execution.b, b: execution.a }); }}><ArrowLeftRight size={18} aria-hidden="true" /></Button>] : [slot];
                })}
              </div>
              <p className="hint">They run one after the other, first then second. Each side uses its selected model and effort for this job. Blank fields inherit the profile settings.</p>
            </section>
            <section className="panel flex flex-col gap-3" aria-labelledby="project-heading">
              <h2 id="project-heading" className="text-heading">Project</h2>
              <div className="flex flex-wrap gap-4">
                <div className="flex-1 min-w-[220px]">
                  <label htmlFor={ids.repo} className="field-label">Repository</label>
                  <input id={ids.repo} list={ids.repos} className="input font-mono" value={repository} onChange={event => {
                    setRepository(event.target.value); setExecution({ a: {}, b: {} });
                    const match = data.repositories.find(item => item.path === event.target.value);
                    if (match) setCommit(match.commit);
                  }} />
                  <datalist id={ids.repos}>{data.repositories.map(r => <option key={r.path} value={r.path} />)}</datalist>
                </div>
                <div className="min-w-[180px]">
                  <label htmlFor={ids.commit} className="field-label">Commit or branch</label>
                  <input id={ids.commit} className="input font-mono" value={commit} onChange={event => setCommit(event.target.value)} />
                </div>
              </div>
              <p className="hint">Each profile starts in its own copy of this commit. Uncommitted edits and untracked or ignored files aren’t included.</p>
            </section>
            <section className="panel flex flex-col gap-3" aria-labelledby="checks-heading">
              <h2 id="checks-heading" className="text-heading">Verification <span className="hint font-normal">· optional</span></h2>
              {checks.length === 0 ? <p className="text-ui"><span className="font-medium">No verification checks selected.</span> <span className="muted">Checks are optional and verify only their stated criteria.</span></p> : null}
              {checks.map((check, index) => (
                <div key={index} className="flex flex-wrap gap-3 items-end">
                  <div className="min-w-[160px]"><label className="field-label" htmlFor={`check-name-${index}`}>Name</label>
                    <input id={`check-name-${index}`} className="input" value={check.name} onChange={event => setChecks(list => list.map((c, i) => i === index ? { ...c, name: event.target.value } : c))} /></div>
                  <div className="flex-1 min-w-[220px]"><label className="field-label" htmlFor={`check-cmd-${index}`}>Command you already use</label>
                    <input id={`check-cmd-${index}`} className="input font-mono" value={check.command} onChange={event => setChecks(list => list.map((c, i) => i === index ? { ...c, command: event.target.value } : c))} /></div>
                  <Button onClick={() => setChecks(list => list.filter((_, i) => i !== index))}>Remove</Button>
                </div>
              ))}
              {checks.length ? <p className="text-ui" style={{ color: 'var(--color-warning)' }}>Checks run in each profile’s copy after its task, as ordinary programs on this Mac, outside the Codex sandbox. Only add commands you trust.</p> : null}
              <div><Button className="border-dashed" onClick={() => setChecks(list => [...list, { name: '', command: '' }])}>Add a check command</Button></div>
            </section>
            <section className="panel flex flex-col gap-3" aria-labelledby="advanced-heading">
              <h2 id="advanced-heading" className="text-body font-semibold">Advanced settings</h2>
              <button type="button" className="btn btn-link self-start text-left" aria-expanded={settingsOpen} aria-controls={ids.advanced} onClick={() => setSettingsOpen(value => !value)}>
                {settingsOpen ? 'Hide advanced settings' : `${advanced?.timeMinutes ?? cap?.timeMinutes} min per run · ${advanced?.outputMiB ?? cap?.outputMiB ?? 8} MiB output · ${advanced?.setup.length ?? 0} setup commands`}
              </button>
              <div id={ids.advanced} hidden={!settingsOpen} className="flex flex-col gap-3 text-ui">
                <div className="flex flex-wrap gap-3">
                  <div className="flex-1 min-w-[140px]"><label className="field-label" htmlFor={`${ids.advanced}-time`}>Time per run (minutes)</label><input id={`${ids.advanced}-time`} type="number" min="1" max="240" className="input" value={advanced?.timeMinutes ?? cap?.timeMinutes ?? 15} onChange={event => setAdvanced(old => ({ timeMinutes: Number(event.target.value), outputMiB: old?.outputMiB ?? cap?.outputMiB ?? 8, program: old?.program ?? '', setup: old?.setup ?? [] }))} /></div>
                  <div className="flex-1 min-w-[140px]"><label className="field-label" htmlFor={`${ids.advanced}-output`}>Output cap (MiB)</label><input id={`${ids.advanced}-output`} type="number" min="1" max="64" className="input" value={advanced?.outputMiB ?? cap?.outputMiB ?? 8} onChange={event => setAdvanced(old => ({ timeMinutes: old?.timeMinutes ?? cap?.timeMinutes ?? 15, outputMiB: Number(event.target.value), program: old?.program ?? '', setup: old?.setup ?? [] }))} /></div>
                </div>
                <div className="flex flex-wrap gap-3">
                  <div className="flex-1 min-w-[200px]"><label className="field-label" htmlFor={`${ids.advanced}-program`}>Codex program <span className="font-normal muted">(blank uses profile default)</span></label><input id={`${ids.advanced}-program`} placeholder={cap?.program || 'Profile default'} className="input font-mono" value={advanced?.program ?? ''} onChange={event => setAdvanced(old => ({ timeMinutes: old?.timeMinutes ?? cap?.timeMinutes ?? 15, outputMiB: old?.outputMiB ?? cap?.outputMiB ?? 8, program: event.target.value, setup: old?.setup ?? [] }))} /></div>
                </div>
                {(advanced?.setup ?? []).map((item, index) => {
                  const nameId = `${ids.advanced}-setup-${index}-name`;
                  const commandId = `${ids.advanced}-setup-${index}-command`;
                  return (
                    <div key={index} className="flex flex-wrap gap-3 items-end">
                      <div className="flex-1 min-w-[160px]">
                        <label className="field-label" htmlFor={nameId}>Setup name</label>
                        <input id={nameId} className="input" value={item.name} onChange={event => setAdvanced(old => ({ timeMinutes: old?.timeMinutes ?? cap?.timeMinutes ?? 15, outputMiB: old?.outputMiB ?? cap?.outputMiB ?? 8, program: old?.program ?? '', setup: (old?.setup ?? []).map((entry, i) => i === index ? { ...entry, name: event.target.value } : entry) }))} />
                      </div>
                      <div className="flex-[2] min-w-[220px]">
                        <label className="field-label" htmlFor={commandId}>Command</label>
                        <input id={commandId} className="input font-mono" value={item.command} onChange={event => setAdvanced(old => ({ timeMinutes: old?.timeMinutes ?? cap?.timeMinutes ?? 15, outputMiB: old?.outputMiB ?? cap?.outputMiB ?? 8, program: old?.program ?? '', setup: (old?.setup ?? []).map((entry, i) => i === index ? { ...entry, command: event.target.value } : entry) }))} />
                      </div>
                      <Button onClick={() => setAdvanced(old => old && ({ ...old, setup: old.setup.filter((_, i) => i !== index) }))}>Remove</Button>
                    </div>
                  );
                })}
                <div><Button className="border-dashed" onClick={() => setAdvanced(old => ({ timeMinutes: old?.timeMinutes ?? cap?.timeMinutes ?? 15, outputMiB: old?.outputMiB ?? cap?.outputMiB ?? 8, program: old?.program ?? '', setup: [...(old?.setup ?? []), { name: '', command: '' }] }))}>Add setup command</Button></div>
                <p className="hint">Overrides apply to this run only; saved profile settings stay as they are.</p>
              </div>
            </section>
          </div>
          <aside className="panel flex flex-col gap-3" style={{ flex: '1 1 320px' }} aria-labelledby="this-run">
            <h2 id="this-run" className="text-heading">This run</h2>
            <dl className="grid gap-x-4 gap-y-2 text-ui" style={{ gridTemplateColumns: 'auto 1fr' }}>
              <dt className="muted">Profiles</dt><dd>{a ? <SideText side="a">{a}</SideText> : '–'} then {b ? <SideText side="b">{b}</SideText> : '–'}</dd>
              <dt className="muted">Model runs</dt><dd>2</dd>
              <dt className="muted">Time limit per profile</dt><dd>2 profiles · {advanced?.timeMinutes ?? cap?.timeMinutes ?? 15} min each</dd>
              <dt className="muted">Commands</dt><dd>{checks.filter(c => c.command.trim()).length} checks · {advanced?.setup.filter(item => item.command.trim()).length ?? 0} setup commands</dd>
            </dl>
            <p className="hint">Each run uses that profile’s sign-in. Open Codex windows keep running.</p>
            {error ? <ErrorPanel title="Not ready">{error}</ErrorPanel> : null}
            <Button type="submit" variant="primary" disabled={!a || !b} onClick={() => setError(null)}>Review before starting</Button>
            <p className="hint">Checks profiles, project and commit. Starts nothing.</p>
          </aside>
        </form>
      ) : null}
    </Page>
  );
}

export function RunReview() {
  const info = useInfo();
  const navigate = useNavigate();
  const request = loadDraft();
  const preview = useResource(() => request ? apiPost<RunPreview>('/api/runs/preview', request) : Promise.reject(new Error('Nothing to review. Describe the task first.')), JSON.stringify(request));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!info?.features.runs) return <NotInThisBuild />;
  const data = preview.data;

  async function start() {
    if (!request || !preview.data?.previewToken || busy) return;
    setBusy(true); setError(null);
    try {
      const run = await apiPost<{ id: string }>('/api/runs', { previewToken: preview.data.previewToken });
      notifyInfoChanged();
      try { sessionStorage.removeItem(DRAFT); } catch { /* convenience only */ }
      navigate(`/runs/${encodeURIComponent(run.id)}`);
    } catch (reason) { setError(reason instanceof ApiError ? reason.message : String(reason)); setBusy(false); }
  }
  const startButton = data?.ready && data.previewToken ? <Button variant="primary" busy={busy} busyLabel="Starting…" onClick={() => void start()}>Start 2 model runs</Button> : null;
  return (
    <Page current="compare" title="Review before starting" reading>
      <PageTitle breadcrumb={[{ label: 'Compare', to: '/' }, { label: 'Run a new task', to: '/runs/new' }, { label: 'Review' }]} title="Review before starting" />
      {data?.simulated ? <SimulatedNote>Starting is simulated; no model task starts.</SimulatedNote> : null}
      {preview.error ? <ErrorPanel title="Can’t review this run" actions={<><Button onClick={preview.reload}>Refresh preview</Button><Link className="btn" to="/runs/new">Back to edit</Link></>}>{preview.error.message}</ErrorPanel> : null}
      {preview.loading && !data ? <Loading label="Checking profiles, project and commit…" rows={2} /> : null}
      {data?.ready && !data.previewToken ? <ErrorPanel title="Preview cannot be started" actions={<><Button onClick={preview.reload}>Refresh preview</Button><Link className="btn" to="/runs/new">Back to edit</Link></>}>The app did not return a start token. Nothing has started.</ErrorPanel> : null}
      {data ? (
        <>
          {data.blocked ? (
            <WarningAlert title={data.blocked.title} actions={<><Link className="btn btn-primary" to="/profiles">Open Profiles</Link><Link className="btn" to="/runs/new">Choose another profile</Link></>}>
              <p>{data.blocked.reason}</p>
              <p className="mt-2"><Button disabled aria-describedby="start-reason">Start 2 model runs</Button> <span id="start-reason" className="hint">Unavailable until this is resolved.</span></p>
            </WarningAlert>
          ) : (
            <section className="panel flex flex-col gap-3" style={{ borderTop: '3px solid var(--color-link-focus)' }} aria-labelledby="ready">
              <p id="ready" className="flex flex-wrap gap-2 items-center"><StatusBadge status="success">Ready to start</StatusBadge><span className="hint">Profiles, project and commit checked · nothing has started</span></p>
              <p className="flex flex-wrap items-center gap-2"><ProfileChip side="a" name={data.runs[0]!.profile} /><span className="hint">then</span><ProfileChip side="b" name={data.runs[1]!.profile} /><span className="text-ui">{data.summary}</span></p>
              {data.checks.length ? <p className="text-ui"><span className="font-medium">{data.checks.length} check after each task:</span> {data.checks.join(', ')}. Its result is reported next to what the agent said.</p>
                : <InfoNotice title="No verification checks selected." action={<Link className="btn" to="/runs/new">Add a check</Link>}>The report will say so. Finishing the task won’t show whether the change works.</InfoNotice>}
              {error ? <ErrorPanel title="Start request failed" actions={<Button onClick={() => { setError(null); preview.reload(); }}>Refresh preview</Button>}>{error} The preview token is retained. Refresh it only after checking the error; a network failure may leave the start outcome uncertain.</ErrorPanel> : null}
              <div className="flex flex-wrap gap-2">{startButton}<Link className="btn" to="/runs/new">Back to edit</Link></div>
            </section>
          )}
          <h2 className="text-heading">Details</h2>
          <section className="flex flex-col gap-2" aria-labelledby="d-task"><h3 id="d-task" className="text-body font-semibold">Task <Link to="/runs/new" className="text-ui font-normal ml-2">Edit</Link></h3>
            <blockquote className="panel text-ui m-0 whitespace-pre-wrap wrap-anywhere">{data.task}</blockquote>
            {data.files ? <p className="text-ui">May change <span className="font-mono">{data.files}</span> · the same text goes to both profiles</p> : null}</section>
          <section className="flex flex-col gap-2" aria-labelledby="d-runs"><h3 id="d-runs" className="text-body font-semibold">Runs, in order</h3>
            <ol className="list-none p-0 flex flex-col gap-2">{data.runs.map((run, index) => (
              <li key={run.side} className={cn('rounded-control px-4 py-3 flex flex-col gap-1', run.side === 'a' ? 'edge-a' : 'edge-b')}>
                <SideText side={run.side}>{index + 1} · {run.profile}</SideText><span className="text-ui wrap-anywhere">{run.text}</span>{run.note ? <span className="hint wrap-anywhere">{run.note}</span> : null}
              </li>))}</ol></section>
          <DetailList id="d-where" title="Where each run starts" items={data.where} />
          <DetailList id="d-advanced" title="Run settings" items={request?.advanced ? [`Time limit: ${request.advanced.timeMinutes} minutes per run`, `Output cap: ${request.advanced.outputMiB} MiB`, `Codex program: ${request.advanced.program || 'profile default'}`, ...(request.advanced.setup.length ? request.advanced.setup.map(item => `Setup ${item.name || '(unnamed)'}: ${item.command}`) : ['No setup commands'])] : ['Profile defaults apply.']} />
          <DetailList id="d-checks" title="Verification" items={data.checks.length ? [...data.checks, 'Runs your command in each profile’s copy after its task, as an ordinary program on this Mac, outside the Codex sandbox.'] : ['None selected. See the note at the top.']} />
          <DetailList id="d-limits" title="Limits" items={data.limits} />
          <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))' }}>
            <DetailList id="d-will" title="Starting will" items={data.willDo} panel />
            <DetailList id="d-never" title="It never" items={data.never} panel />
          </div>
          <div className="flex flex-wrap gap-2 pt-4 border-t" style={{ borderColor: 'var(--color-divider)' }}>{startButton}<Link className="btn" to="/runs/new">Back to edit</Link></div>
        </>
      ) : null}
    </Page>
  );
}

function DetailList({ id, title, items, panel = false }: { id: string; title: string; items: string[]; panel?: boolean }) {
  return (
    <section className={cn('flex flex-col gap-2', panel && 'panel')} aria-labelledby={id}>
      <h3 id={id} className="text-body font-semibold">{title}</h3>
      <ul className="text-ui list-disc pl-5 flex flex-col gap-1 wrap-anywhere">{items.map(item => <li key={item}>{item}</li>)}</ul>
    </section>
  );
}

const END_STATUS: Record<RunView['state'], 'neutral' | 'warning' | 'error'> = {
  running: 'neutral', finished: 'neutral', 'finished-partial': 'neutral', cancelled: 'neutral', 'check-failed': 'error', 'time-limit': 'warning', interrupted: 'warning', 'cannot-tidy': 'warning', failed: 'error',
};

export function RunProgress() {
  const { id = '' } = useParams();
  const info = useInfo();
  const [data, setData] = useState<RunView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [announce, setAnnounce] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const readSequence = useRef(0);
  const routeGeneration = useRef(0);
  const currentRoute = useRef(id);
  currentRoute.current = id;
  const readQueue = useRef<Promise<unknown>>(Promise.resolve());
  const pollInFlight = useRef(false);
  const previousState = useRef<RunView['state'] | null>(null);
  const running = data?.state === 'running';
  const readRun = useCallback((routeId: string) => {
    const route = routeGeneration.current;
    const sequence = ++readSequence.current;
    setLoading(true);
    setLoadError(null);
    const request = readQueue.current.catch(() => undefined).then(() => apiGet<RunView>(`/api/runs/${encodeURIComponent(routeId)}`));
    readQueue.current = request;
    return request.then(next => {
      if (route === routeGeneration.current && routeId === currentRoute.current && sequence === readSequence.current) {
        setData(next); setPollError(null); setLoadError(null);
      }
    }, reason => {
      if (route === routeGeneration.current && routeId === currentRoute.current && sequence === readSequence.current) {
        const error = reason instanceof Error ? reason : new Error(String(reason));
        setLoadError(error); setPollError(error.message);
      }
    }).finally(() => {
      if (route === routeGeneration.current && routeId === currentRoute.current && sequence === readSequence.current) setLoading(false);
    });
  }, []);
  useEffect(() => {
    const route = ++routeGeneration.current;
    setData(null); setLoading(true); setLoadError(null); setPollError(null); setActionError(null); setBusy(false); setConfirmCancel(false);
    previousState.current = null;
    void readRun(id);
    return () => { if (routeGeneration.current === route) routeGeneration.current++; readSequence.current++; };
  }, [id, readRun]);
  useEffect(() => {
    if (previousState.current === 'running' && data && data.state !== 'running') notifyInfoChanged();
    previousState.current = data?.state ?? null;
  }, [data?.state]);
  useEffect(() => {
    if (!running || busy) return;
    let active = true;
    const timer = window.setInterval(() => {
      if (!active || pollInFlight.current) return;
      pollInFlight.current = true;
      void readRun(id).finally(() => { pollInFlight.current = false; });
    }, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [running, id, busy, readRun]);
  // Announce at most once per step change, not per event.
  const headline = data ? `${data.headline}${data.columns.map(c => c.steps.find(s => s.state === 'active')?.text ?? '').join(' ')}` : '';
  useEffect(() => { if (data) setAnnounce(data.headline); }, [headline]);

  async function respond(requestId: string, response: ReviewTaskDecision) {
    const route = routeGeneration.current, sequence = ++readSequence.current;
    setActionError(null);
    try {
      const next = await apiPost<RunView>(`/api/runs/${encodeURIComponent(id)}/requests/${encodeURIComponent(requestId)}`, { response });
      if (route === routeGeneration.current && sequence === readSequence.current) setData(next);
    } catch (reason) {
      if (route === routeGeneration.current) setActionError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    }
  }

  async function act(path: 'cancel' | 'recover') {
    const route = routeGeneration.current;
    const sequence = ++readSequence.current;
    setBusy(true);
    setActionError(null);
    try {
      const next = await apiPost<RunView>(`/api/runs/${encodeURIComponent(id)}/${path}`, path === 'recover' && data?.recovery?.previewToken ? { previewToken: data.recovery.previewToken } : {});
      if (route === routeGeneration.current && id === currentRoute.current && sequence === readSequence.current) { setData(next); setPollError(null); setLoadError(null); notifyInfoChanged(); }
    } catch (reason) {
      if (route === routeGeneration.current && id === currentRoute.current && sequence === readSequence.current) setActionError(reason instanceof ApiError ? `${reason.code}: ${reason.message}` : String(reason));
    } finally {
      if (route === routeGeneration.current && id === currentRoute.current) { setBusy(false); setConfirmCancel(false); }
    }
  }
  if (!info?.features.runs) return <NotInThisBuild />;
  return (
    <Page current="compare" title="Run progress">
      {loadError && !data ? <LoadError error={loadError} onRetry={() => void readRun(id)} /> : null}
      {loading && !data ? <Loading label="Reading the run’s state…" /> : null}
      {data ? (
        <>
          <PageTitle breadcrumb={[{ label: 'Compare', to: '/' }, { label: 'Run a new task' }, { label: 'Progress' }]} title={running ? `Running: ${data.task}` : data.task} subtitle={data.meta} />
          {data.simulated ? <SimulatedNote>This run is simulated.</SimulatedNote> : null}
          <p className="sr-only" role="status" aria-live="polite">{announce}</p>
          <section className="panel flex flex-col gap-4" aria-labelledby="run-state">
            <div className="flex flex-wrap items-center gap-3">
              <StatusBadge status={END_STATUS[data.state]}>{data.stateText}</StatusBadge>
              <h2 id="run-state" className="text-heading">{data.headline}</h2>
            </div>
            {data.elapsed ? <p className="text-ui tabular-nums">{data.elapsed}</p> : null}
            {pollError ? <ErrorPanel title="Couldn’t refresh progress" actions={<Button disabled={busy} onClick={() => void readRun(id)}>Retry read</Button>}>{pollError} The last confirmed run state remains shown.</ErrorPanel> : null}
            {actionError ? <ErrorPanel title="Action failed" actions={<Button onClick={() => setActionError(null)}>Dismiss</Button>}>{actionError}</ErrorPanel> : null}
            {running && data.timeUsed !== null ? <div className="progress-track" role="progressbar" aria-label="Time used of the overall limit" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(data.timeUsed * 100)}>
              <div className="progress-fill" style={{ width: `${Math.round(data.timeUsed * 100)}%` }} /></div> : null}
            <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))' }}>
              {data.columns.map((column, index) => (
                <div key={column.side} className="rounded-control p-4 flex flex-col gap-2" style={{ border: '1px solid var(--color-divider)', borderTop: `3px solid var(--color-side-${column.side})` }}>
                  <div className="flex flex-wrap justify-between gap-2"><SideText side={column.side}>{index + 1} · {column.profile}</SideText><span className="badge">{column.state}</span></div>
                  {data.pendingRequests?.filter(request => request.side === column.side).map(request =>
                    <NativeReviewRequest key={request.requestId} request={request} busy={busy || data.pendingRequests?.[0]?.requestId !== request.requestId} onRespond={response => respond(request.requestId, response)} />)}
                  {column.failure ? <ErrorPanel live={false} title={column.failure.includes("rate limit") ? "Native usage limit reached" : "Model task did not start"}>{column.failure}</ErrorPanel> : null}
                  <ol className="list-none p-0 flex flex-col gap-1 text-ui">
                    {column.steps.map(step => (
                      <li key={step.text} className={cn((step.state === 'waiting' || step.state === 'skipped') && 'muted', step.state === 'active' && 'font-semibold')}>
                        <span aria-hidden="true">{step.state === 'done' ? '✓ ' : step.state === 'active' ? '→ ' : step.state === 'failed' ? '✕ ' : step.state === 'skipped' ? '– ' : '· '}</span>
                        {step.text}<span className="sr-only"> ({step.state})</span>
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
            </div>
            {data.sofar ? <p className="hint">{data.sofar}</p> : null}
            {data.recovery ? (
              <WarningAlert title="Before changing anything, here’s what tidying up would do:" actions={<><Button variant="primary" busy={busy} busyLabel="Tidying up…" onClick={() => void act('recover')}>Tidy up and keep the record</Button><Link className="btn" to="/">Not now</Link></>}>
                <ul className="list-disc pl-5">{data.recovery.facts.map(fact => <li key={fact}>{fact}</li>)}</ul>
              </WarningAlert>
            ) : null}
            {data.reportHref ? <div><Link className="btn btn-primary" to={data.reportHref}>{['finished', 'finished-partial', 'check-failed'].includes(data.state) ? 'Open the report' : 'Open the partial report'}</Link></div> : null}
            {running ? (
              confirmCancel ? (
                <WarningAlert live title="Cancel the run?" actions={<><Button variant="destructive" busy={busy} busyLabel="Cancelling…" onClick={() => void act('cancel')}>Cancel the run</Button><Button onClick={() => setConfirmCancel(false)}>Keep running</Button></>}>
                  Cancelling stops the working profile now and keeps what was recorded, marked partial. A profile that already finished stays complete.
                </WarningAlert>
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <Button variant="destructive-outline" onClick={() => setConfirmCancel(true)}>Cancel the run…</Button>
                  <span className="hint">Refreshing or closing this tab doesn’t stop anything; open Xenoflux again to see where it is.</span>
                </div>
              )
            ) : null}
            <p className="hint">Stopping Xenoflux interrupts its owned run and keeps the recorded evidence. Reopening never restarts a model task.</p>
          </section>
        </>
      ) : null}
    </Page>
  );
}
