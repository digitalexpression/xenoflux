import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { Check, ChevronRight, Circle, CircleAlert, Columns2, CornerDownRight, FilePenLine, ListChecks, Minus, Play, ShieldCheck } from 'lucide-react';
import { ApiError, apiGet, apiPost } from '@/api/client';
import type { ReviewTaskDecision, RunAdvanced, RunOptions, RunPreview, RunProfileOption, RunRequest, RunView } from '@/api/types';
import { NativeReviewRequest } from '@/components/NativeReviewRequest';
import { StatusBadge } from '@/components/badges';
import { Loading, LoadError, Page, PageTitle, useInfo } from '@/components/layout';
import { ErrorPanel, InfoNotice, SimulatedNote, WarningAlert } from '@/components/notices';
import { ProfileChip, SideText } from '@/components/profile';
import { RunSetupDifferences, RunSetupPair, runProfileKey, runSetupDifferenceCount, type RunBindingResult } from '@/components/run-setup-pair';
import { Button } from '@/components/ui/button';
import { useResource } from '@/lib/useResource';
import { cn } from '@/lib/cn';

const DRAFT = 'xenoflux-run-draft';
function notifyInfoChanged() { window.dispatchEvent(new Event('xenoflux-info-changed')); }
function loadDraft(): RunRequest | null {
  try { const value = sessionStorage.getItem(DRAFT); return value ? JSON.parse(value) as RunRequest : null; } catch { return null; }
}
function saveDraft(request: RunRequest) { try { sessionStorage.setItem(DRAFT, JSON.stringify(request)); } catch { /* the draft is a convenience only */ } }

function repositoriesForProfiles(repositories: RunOptions['repositories'], ...profiles: (RunProfileOption | undefined)[]) {
  return repositories.filter(({ path }) => profiles.every(profile => profile?.boundRepositories?.includes(path) ?? true));
}

function RunStages({ review = false }: { review?: boolean }) {
  return <nav className="run-stages" aria-label="Preparation stages"><ol>
    {[
      { label: 'Task and source', target: 'task-heading', Icon: FilePenLine },
      { label: 'Two setups', target: 'profiles-heading', Icon: Columns2 },
      { label: 'Checks and limits', target: 'checks-heading', Icon: ShieldCheck },
    ].map(({ label, target, Icon }) => <li key={target}><Link to={`${review ? '/runs/new' : ''}#${target}`}><Icon size={16} aria-hidden="true" />{label}</Link></li>)}
    <li><span className="run-stage-review" aria-current={review ? 'step' : undefined}><ListChecks size={16} aria-hidden="true" />Review and start</span></li>
  </ol></nav>;
}

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
  const location = useLocation();
  const options = useResource(() => apiGet<RunOptions>('/api/runs/new'), 'run-options');
  const draft = loadDraft();
  const [task, setTask] = useState(draft?.task ?? '');
  const [files, setFiles] = useState(() => draft?.fileRulesFormat === 'lines' ? draft.files : draft?.files.replaceAll(',', '\n') ?? '');
  const [fileRulesFormat, setFileRulesFormat] = useState<RunRequest['fileRulesFormat']>(() => draft ? draft.fileRulesFormat : 'lines');
  const [a, setA] = useState(draft?.a ? runProfileKey({ name: draft.a, client: draft.clients?.a }) : '');
  const [b, setB] = useState(draft?.b ? runProfileKey({ name: draft.b, client: draft.clients?.b }) : '');
  const inherited = { reasoningEffort: draft?.advanced?.reasoningEffort || undefined };
  const [execution, setExecution] = useState(draft?.execution ?? { a: inherited, b: inherited });
  const [repository, setRepository] = useState(draft?.repository ?? '');
  const repositoryEdited = useRef(false);
  const [repositoryEditing, setRepositoryEditing] = useState(false);
  const [binding, setBinding] = useState(false);
  const [catalogRevisions, setCatalogRevisions] = useState<Record<string, number>>({});
  const [commit, setCommit] = useState(draft?.commit ?? '');
  const [checks, setChecks] = useState(draft?.checks ?? []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [advanced, setAdvanced] = useState<RunAdvanced | null>(() => {
    if (!draft?.advanced) return null;
    const { timeMinutes, outputMiB, program, setup, reasoningEffort } = draft.advanced;
    return { timeMinutes, outputMiB, program, setup, reasoningEffort };
  });
  const [taskError, setTaskError] = useState(false);
  const ids = { task: useId(), files: useId(), repo: useId(), commit: useId(), taskError: useId(), advanced: useId(), repos: useId() };
  const data = options.data;
  useEffect(() => {
    if (!data) return;
    const ready = data.profiles.filter(p => p.ready).map(runProfileKey);
    const defaultA = ready[0] || '', defaultB = ready[1] || defaultA;
    setA(current => current || defaultA);
    setB(current => current || defaultB);
    if (!repository && !repositoryEdited.current) {
      const initialProfiles = [a || defaultA, b || defaultB].map(key => data.profiles.find(profile => runProfileKey(profile) === key));
      const first = repositoriesForProfiles(data.repositories, ...initialProfiles)[0];
      if (first) { setRepository(first.path); setCommit(first.commit); }
    }
  }, [data]);
  useEffect(() => {
    if (!data || !['#task-heading', '#profiles-heading', '#checks-heading'].includes(location.hash)) return;
    const heading = document.getElementById(location.hash.slice(1));
    heading?.focus({ preventScroll: true });
    heading?.scrollIntoView({ block: 'start' });
  }, [data, location.hash, location.key]);

  const left = data?.profiles.find(profile => runProfileKey(profile) === a);
  const right = data?.profiles.find(profile => runProfileKey(profile) === b);
  const hasBindingScope = left && right && Boolean(left.boundRepositories || right.boundRepositories);
  const sharedRepositories = data && hasBindingScope ? repositoriesForProfiles(data.repositories, left, right) : undefined;
  const suggestedRepository = sharedRepositories?.[0];
  const setups = {
    a: { name: left?.name ?? a, client: left?.client, execution: execution.a },
    b: { name: right?.name ?? b, client: right?.client, execution: execution.b },
  };
  const differences = runSetupDifferenceCount(setups);
  function changeRepository(path: string) {
    repositoryEdited.current = true;
    setRepository(path);
    setExecution({ a: {}, b: {} });
    const match = data?.repositories.find(item => item.path === path);
    if (match) setCommit(match.commit);
  }
  function currentDraft(): RunRequest {
    const clients = { a: left?.client, b: right?.client };
    return { task, files, fileRulesFormat, a: left?.name ?? a, b: right?.name ?? b,
      ...(clients.a || clients.b ? { clients } : {}), repository, commit, checks, execution, ...(advanced ? { advanced } : {}) };
  }
  async function bindProfiles(path: string, targets: RunProfileOption[]): Promise<RunBindingResult> {
    setBinding(true);
    saveDraft(currentDraft());
    const bound: string[] = [], keys: string[] = [], failed: RunBindingResult['failed'] = [];
    try {
      for (const profile of targets) {
        try {
          await apiPost(`/api/profiles/${encodeURIComponent(profile.name)}/binding`, { repository: path, ensure: true });
          bound.push(profile.name);
          keys.push(runProfileKey(profile));
        } catch (error) {
          failed.push({ profile: profile.name, message: error instanceof Error ? error.message : String(error) });
        }
      }
      const optionsReloaded = !bound.length || await options.reload();
      if (keys.length) setCatalogRevisions(previous => {
        const next = { ...previous };
        for (const key of keys) next[key] = (next[key] ?? 0) + 1;
        return next;
      });
      return { bound, failed, optionsReloaded };
    } finally { setBinding(false); }
  }
  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (binding) return;
    if (!task.trim()) { setTaskError(true); document.getElementById(ids.task)?.focus(); return; }
    const request = currentDraft();
    saveDraft(request);
    navigate('/runs/new/review', { state: request });
  }
  const cap = data?.defaults;
  return (
    <Page current="compare" title="Run a new task">
      <PageTitle breadcrumb={[{ label: 'Comparisons', to: '/comparisons' }, { label: 'Compare a task' }, { label: 'Run a new task' }]} title="Run a new task" />
      <RunStages />
      {data?.simulated ? <SimulatedNote>Runs are simulated; no model task starts and no files are copied.</SimulatedNote> : null}
      {options.error ? <LoadError error={options.error} onRetry={options.reload} /> : null}
      {options.loading && !data ? <Loading label="Checking profiles and projects…" /> : null}
      {data ? (
        <form className="run-preparation" onSubmit={submit} noValidate>
            <section className="panel p-0" aria-labelledby="task-heading">
              <div className="panel-head run-paired-panel-head"><h2 id="task-heading" className="run-paired-title" tabIndex={-1}><FilePenLine size={16} aria-hidden="true" /> Task and source</h2></div>
              <div className="run-preparation-section">
              <div>
                <label htmlFor={ids.task} className="field-label">What should both profiles do?</label>
                <textarea id={ids.task} className="input" rows={2} value={task} onChange={event => { setTask(event.target.value); setTaskError(false); }}
                  aria-invalid={taskError || undefined} aria-describedby={`${ids.task}-hint${taskError ? ` ${ids.taskError}` : ''}`} />
                {taskError ? <p id={ids.taskError} className="text-ui mt-1" style={{ color: 'var(--color-error)' }}>Describe the task both profiles should do.</p> : null}
                <p id={`${ids.task}-hint`} className="hint mt-1">Sent unchanged to both profiles. Kept private; reports don’t include the text.</p>
              </div>
            <div className="run-source" role="group" aria-label="Source">
              <div className="run-source-fields">
                <div className="min-w-0">
                  <label htmlFor={ids.repo} className="field-label">Repository</label>
                  <input id={ids.repo} list={ids.repos} className="input font-mono" value={repository} disabled={binding}
                    onFocus={() => setRepositoryEditing(true)} onBlur={() => setRepositoryEditing(false)} onChange={event => changeRepository(event.target.value)} />
                  <datalist id={ids.repos}>{data.repositories.map(r => <option key={r.path} value={r.path} />)}</datalist>
                </div>
                <div className="min-w-0">
                  <label htmlFor={ids.commit} className="field-label">Commit or branch</label>
                  <input id={ids.commit} className="input font-mono" value={commit} onChange={event => setCommit(event.target.value)} />
                </div>
              </div>
              <p className="hint">Each profile starts in its own copy of this commit. Uncommitted edits and untracked or ignored files aren’t included.</p>
              <div className="min-w-0">
                <label htmlFor={ids.files} className="field-label">Files it may change <span className="muted font-normal">(optional)</span></label>
                <textarea id={ids.files} className="input font-mono" rows={2} value={files} aria-describedby={`${ids.files}-hint`}
                  onChange={event => { setFiles(event.target.value); setFileRulesFormat('lines'); }} />
                <p id={`${ids.files}-hint`} className="meta mt-1">Enter one relative path or wildcard per line, such as <code>src/**/*.ts</code>. Reports flag edits outside this list.</p>
              </div>
            </div>
            </div>
            </section>
            <RunSetupPair setups={setups} selected={{ a, b }} profiles={data.profiles} workspace={repository}
              workspaceEditing={repositoryEditing} simulated={data.simulated}
              binding={binding} catalogRevisions={catalogRevisions} onBind={bindProfiles}
              noSharedRepository={sharedRepositories?.length === 0}
              repositorySuggestion={suggestedRepository && !sharedRepositories?.some(repo => repo.path === repository) ? suggestedRepository.path : undefined}
              onRepositoryChange={changeRepository}
              onOpenProfiles={() => saveDraft(currentDraft())}
              onProfileChange={(side, key) => { (side === 'a' ? setA : setB)(key); setExecution(current => ({ ...current, [side]: {} })); }}
              onExecutionChange={(side, value) => setExecution(current => ({ ...current, [side]: value }))}
              onSwap={() => { setA(b); setB(a); setExecution(current => ({ a: current.b, b: current.a })); }} />
            <section className="panel p-0" aria-labelledby="checks-heading">
              <div className="panel-head run-paired-panel-head">
                <h2 id="checks-heading" className="run-paired-title" tabIndex={-1}><ShieldCheck size={16} aria-hidden="true" /> Checks and limits</h2>
                <Button variant="ghost-link" onClick={() => setChecks(list => [...list, { name: '', command: '' }])}>Add a check command</Button>
              </div>
              <div className="run-preparation-section">
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
            <div className="run-limits" role="group" aria-labelledby="advanced-heading">
              <h3 id="advanced-heading" className="text-body font-semibold">Limits and setup commands</h3>
              <button type="button" className="btn btn-link self-start text-left" aria-expanded={settingsOpen} aria-controls={ids.advanced} onClick={() => setSettingsOpen(value => !value)}>
                <ChevronRight size={14} aria-hidden="true" />{settingsOpen ? 'Hide advanced settings' : `${advanced?.timeMinutes ?? cap?.timeMinutes} min per run · ${advanced?.outputMiB ?? cap?.outputMiB ?? 8} MiB output · ${advanced?.setup.length ?? 0} setup commands`}
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
            </div></div></section>
          <div className="run-action-bar">
            <p className="meta">{differences} {differences === 1 ? 'difference' : 'differences'} · Left then Right</p>
            <Button type="submit" variant="primary" disabled={!a || !b || binding}>Review before starting <ListChecks size={16} aria-hidden="true" /></Button>
          </div>
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
  const startButton = data?.ready && data.previewToken ? <Button variant="primary" busy={busy} busyLabel="Starting…" onClick={() => void start()}><Play size={16} aria-hidden="true" /> Start 2 model runs</Button> : null;
  return (
    <Page current="compare" title="Review before starting">
      <div className="run-review">
      <PageTitle breadcrumb={[{ label: 'Comparisons', to: '/comparisons' }, { label: 'Run a new task', to: '/runs/new' }, { label: 'Review' }]} title="Review before starting" />
      <RunStages review />
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
            <section className="run-ready" aria-labelledby="ready">
              <p id="ready" className="flex flex-wrap gap-2 items-center"><StatusBadge status="success">Ready to start</StatusBadge><span className="hint">Profiles, project and commit checked · nothing has started</span></p>
              <p className="flex flex-wrap items-center gap-2"><ProfileChip side="a" name={data.runs[0]!.profile} /><span className="hint">then</span><ProfileChip side="b" name={data.runs[1]!.profile} /><span className="text-ui">{data.summary}</span></p>
              {data.checks.length ? <p className="text-ui">{data.checks.length} {data.checks.length === 1 ? 'check runs' : 'checks run'} after each task.</p>
                : <div className="run-verification-note"><p className="text-ui font-medium">No verification checks selected.</p><p className="hint">The report will say so. Finishing the task won’t show whether the change works.</p><Link to="/runs/new#checks-heading">Add a check</Link></div>}
            </section>
          )}
          <div className="run-review-details">
            <section className="panel p-0" aria-labelledby="d-task">
              <div className="panel-head run-paired-panel-head"><h2 id="d-task" className="run-paired-title"><FilePenLine size={16} aria-hidden="true" /> Task and pinned source</h2>
                <Link to="/runs/new#task-heading" className="btn btn-link">Edit task and source</Link></div>
              <div className="run-preparation-section">
                <blockquote className="run-task-text text-ui m-0 whitespace-pre-wrap wrap-anywhere">{data.task}</blockquote>
                {data.files ? <div className="text-ui"><p>Files it may change</p><p className="font-mono whitespace-pre-wrap wrap-anywhere">{data.files}</p></div> : null}
                <DetailList id="d-where" title="Where each run starts" items={data.where} />
              </div>
            </section>
            {request ? <RunSetupDifferences request={request} profiles={{ a: data.runs.find(run => run.side === 'a')?.profile ?? request.a,
              b: data.runs.find(run => run.side === 'b')?.profile ?? request.b }} /> : null}
            <div className="flex flex-wrap gap-2">
              <Link className="btn btn-link" to="/runs/new#profiles-heading">Edit the two setups</Link>
              <Link className="btn btn-link" to="/runs/new#checks-heading">Edit checks and limits</Link>
            </div>
            <section className="panel p-0" aria-labelledby="review-limits">
              <div className="panel-head run-paired-panel-head"><h2 id="review-limits" className="run-paired-title"><ShieldCheck size={16} aria-hidden="true" /> Checks and limits</h2></div>
              <div className="run-preparation-section">
                {data.checks.length ? <DetailList id="d-checks" title="Verification" items={[...data.checks, 'Checks run in each copy as ordinary programs on this Mac, outside the model sandbox.']} /> : null}
                <DetailList id="d-limits" title="Execution limits" items={data.limits} />
                <details className="run-review-disclosure">
                  <summary className="btn btn-link"><ChevronRight size={14} aria-hidden="true" /> Prepared run details</summary>
                  <div className="run-preparation-section px-0">
                    <section className="flex flex-col gap-2" aria-labelledby="d-runs"><h3 id="d-runs" className="text-body font-semibold">Runs, in order</h3>
                      <ol className="run-review-sides">{data.runs.map((run, index) => (
                        <li key={run.side} className="run-review-side">
                          <SideText side={run.side}>{index + 1} · {run.profile}</SideText><span className="text-ui wrap-anywhere">{run.text}</span>{run.note ? <span className="hint wrap-anywhere">{run.note}</span> : null}
                        </li>))}</ol></section>
                    <DetailList id="d-advanced" title="Run settings" items={request?.advanced ? [`Time limit: ${request.advanced.timeMinutes} minutes per run`, `Output cap: ${request.advanced.outputMiB} MiB`, `Codex program: ${request.advanced.program || 'profile default'}`, ...(request.advanced.setup.length ? request.advanced.setup.map(item => `Setup ${item.name || '(unnamed)'}: ${item.command}`) : ['No setup commands'])] : ['Profile defaults apply.']} />
                    <div className="flex flex-wrap gap-4">
                      <DetailList id="d-will" title="Starting will" items={data.willDo} />
                      <DetailList id="d-never" title="It never" items={data.never} />
                    </div>
                  </div>
                </details>
              </div>
            </section>
          </div>
          {error ? <ErrorPanel title="Start request failed" actions={<Button onClick={() => { setError(null); preview.reload(); }}>Refresh preview</Button>}>{error} The preview token is retained. Refresh it only after checking the error; a network failure may leave the start outcome uncertain.</ErrorPanel> : null}
          {!data.blocked ? <div className="run-action-bar"><Link className="btn" to="/runs/new">Back to edit</Link>{startButton}</div> : null}
        </>
      ) : null}
      </div>
    </Page>
  );
}

function DetailList({ id, title, items }: { id: string; title: string; items: string[] }) {
  return (
    <section className="flex flex-col gap-1" aria-labelledby={id}>
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
    <Page current="activity" title="Run progress">
      {loadError && !data ? <LoadError error={loadError} onRetry={() => void readRun(id)} /> : null}
      {loading && !data ? <Loading label="Reading the run’s state…" /> : null}
      {data ? (
        <>
          <PageTitle breadcrumb={[{ label: 'Activity', to: '/activity' }, { label: 'Comparison progress' }]} title={running ? `Running: ${data.task}` : data.task} subtitle={data.meta} />
          {data.simulated ? <SimulatedNote>This run is simulated.</SimulatedNote> : null}
          <p className="sr-only" role="status" aria-live="polite">{announce}</p>
          <section className="run-progress flex flex-col gap-4" aria-labelledby="run-state">
            <div className="flex flex-wrap items-center gap-3">
              <StatusBadge status={END_STATUS[data.state]}>{data.stateText}</StatusBadge>
              <h2 id="run-state" className="text-heading">{data.headline}</h2>
            </div>
            {data.elapsed ? <p className="text-ui tabular-nums">{data.elapsed}</p> : null}
            {pollError ? <ErrorPanel title="Couldn’t refresh progress" actions={<Button disabled={busy} onClick={() => void readRun(id)}>Retry read</Button>}>{pollError} The last confirmed run state remains shown.</ErrorPanel> : null}
            {actionError ? <ErrorPanel title="Action failed" actions={<Button onClick={() => setActionError(null)}>Dismiss</Button>}>{actionError}</ErrorPanel> : null}
            {running && data.timeUsed !== null ? <div className="progress-track" role="progressbar" aria-label="Time used of the overall limit" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(data.timeUsed * 100)}>
              <div className="progress-fill" style={{ width: `${Math.round(data.timeUsed * 100)}%` }} /></div> : null}
            <div className="run-progress-sides">
              {data.columns.map((column, index) => (
                <section key={column.side} className="run-progress-side" aria-label={`${column.side === 'a' ? 'Left' : 'Right'} · ${column.profile}`}>
                  <div className="flex flex-wrap justify-between gap-2"><SideText side={column.side}>{index + 1} · {column.side === 'a' ? 'Left' : 'Right'} · {column.profile}</SideText><span className="flex flex-wrap items-center gap-2">{!running ? <span className="hint">Last recorded state</span> : null}<span className="badge">{column.state}</span></span></div>
                  {data.pendingRequests?.filter(request => request.side === column.side).map(request =>
                    <NativeReviewRequest key={request.requestId} request={request} busy={busy || data.pendingRequests?.[0]?.requestId !== request.requestId} onRespond={response => respond(request.requestId, response)} />)}
                  {column.failure ? <ErrorPanel live={false} title={column.failure.includes("rate limit") ? "Native usage limit reached" : "Model task did not start"}>{column.failure}</ErrorPanel> : null}
                  {!running ? <p className="hint">Retained step history · these steps are no longer live</p> : null}
                  <ol className="run-step-list text-ui">
                    {column.steps.map(step => (
                      <li key={step.text} className={cn((step.state === 'waiting' || step.state === 'skipped') && 'muted', step.state === 'active' && 'font-semibold')}>
                        <span className="run-step-icon" aria-hidden="true">{step.state === 'done' ? <Check size={16} /> : step.state === 'active' ? <CornerDownRight size={16} /> : step.state === 'failed' ? <CircleAlert size={16} /> : step.state === 'skipped' ? <Minus size={16} /> : <Circle size={12} />}</span>
                        {step.text}<span className="sr-only"> ({step.state})</span>
                      </li>
                    ))}
                  </ol>
                </section>
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
