import { useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ApiError, apiGet, apiPost } from '@/api/client';
import type { ClientAction, ClientActionResult, MenuAction, NativeAppEntry, NativeAppOpenResult, NativeAppsView, ProfileCard, ProfileClient, ProfilesView, StatusKind } from '@/api/types';
import { Disclosure } from '@/components/controls';
import { Loading, LoadError, Page, PageTitle, useInfo } from '@/components/layout';
import { ErrorPanel, SimulatedNote, WarningAlert } from '@/components/notices';
import { StatusBadge } from '@/components/badges';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useResource } from '@/lib/useResource';

const clientLabels: Record<ProfileClient, string> = { codex: 'Codex', 'claude-code': 'Claude Code', copilot: 'Copilot CLI' };

type DialogState =
  | { kind: 'conflict'; profile: string; action: ClientAction }
  | { kind: 'create' }
  | { kind: 'add' }
  | { kind: 'rename' | 'binding' | 'remove'; profile: string }
  | { kind: 'compare'; profile: string }
  | null;

export function Profiles() {
  const info = useInfo();
  const [params, setParams] = useSearchParams();
  const view = useResource(() => apiGet<ProfilesView>('/api/profiles'), 'profiles');
  const [dialog, setDialog] = useState<DialogState>(null);
  const [message, setMessage] = useState<{ status: StatusKind; text: string } | null>(null);

  useEffect(() => {
    if (params.get('create')) setDialog({ kind: 'create' });
    else if (params.get('add')) setDialog({ kind: 'add' });
  }, [params]);
  const close = () => { setDialog(null); if (params.size) setParams({}, { replace: true }); };

  async function runClientAction(profile: ProfileCard, action: ClientAction) {
    if (action.conflict) { setDialog({ kind: 'conflict', profile: profile.name, action }); return; }
    try {
      const result = await apiPost<ClientActionResult>(`/api/profiles/${encodeURIComponent(profile.name)}/clients`, { action: action.id });
      setMessage({ status: result.status, text: result.message });
      view.reload();
    } catch (error) { setMessage({ status: 'error', text: (error as Error).message }); }
  }

  const names = view.data?.profiles.filter(p => !p.client || p.client === 'codex').map(p => p.name) ?? [];
  return (
    <Page current="profiles" title="Profiles">
      <PageTitle title="Profiles"
        subtitle="Profiles keep separate settings and history. Sign-in may belong to a profile or be shared through the native client."
        actions={info?.features.profileEdits ? (
          <>
            <Button onClick={() => setDialog({ kind: 'add' })}>Add an existing Codex folder…</Button>
            {info.features.create ? <Button onClick={() => setDialog({ kind: 'create' })}>Create profile…</Button> : null}
          </>
        ) : undefined} />
      {view.data?.simulated ? <SimulatedNote>Client controls and profile changes are simulated; nothing is opened, closed or written.</SimulatedNote> : null}
      {message ? (
        <div role="status" className={message.status === 'error' ? 'alert-error' : message.status === 'success' ? 'alert-success' : 'notice'}>{message.text}</div>
      ) : null}
      {view.error ? <LoadError error={view.error} onRetry={view.reload} /> : null}
      {view.loading && !view.data ? <Loading label="Reading profiles…" /> : null}
      {view.data && view.data.profiles.length === 0 ? (
        <div className="panel flex flex-col gap-2">
          <h2 className="text-heading">No profiles yet</h2>
          <p className="muted">Add an existing Codex folder or create a profile. Your normal Codex setup appears as Default once Xenoflux can read it.</p>
        </div>
      ) : null}
      {view.data ? (
        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(340px, 100%), 1fr))' }}>
          {view.data.profiles.map(profile => (
            <ProfileCardView key={profile.name} profile={profile} canCompare={names.includes(profile.name) && names.length > 1}
              onClient={action => runClientAction(profile, action)} onMenu={menu => {
                if (menu.id === 'copy') return;
                setDialog({ kind: menu.id, profile: profile.name });
              }} onCompare={() => setDialog({ kind: 'compare', profile: profile.name })} />
          ))}
        </div>
      ) : null}
      {view.data?.notes.length ? <ul className="hint list-disc pl-5">{view.data.notes.map(note => <li key={note}>{note}</li>)}</ul> : null}

      <NativeApps />

      <ConflictDialog state={dialog?.kind === 'conflict' ? dialog : null} onClose={close}
        onCheck={async name => { await apiPost(`/api/profiles/${encodeURIComponent(name)}/clients`, { action: 'check' }); view.reload(); close(); }} />
      <CreateDialog open={dialog?.kind === 'create'} onClose={close} sources={view.data?.copySources ?? { codex: names, 'claude-code': [], copilot: [] }}
        onCreated={text => { setMessage({ status: 'success', text }); view.reload(); close(); }} />
      <CompareDialog state={dialog?.kind === 'compare' ? dialog : null} names={names} onClose={close} />
      <SimpleEditDialog state={dialog && (dialog.kind === 'rename' || dialog.kind === 'binding' || dialog.kind === 'remove' || dialog.kind === 'add') ? dialog : null}
        onClose={close} onDone={(text, status) => { setMessage({ status, text }); view.reload(); close(); }} />
    </Page>
  );
}

function NativeApps() {
  const apps = useResource(() => apiGet<NativeAppsView>('/api/apps'), 'native-apps');
  const [busy, setBusy] = useState<NativeAppEntry['client'] | null>(null);
  const pending = useRef(false);
  const sessionInputId = useId();
  const [sessionId, setSessionId] = useState('');
  const [openingSession, setOpeningSession] = useState(false);
  const sessionValid = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const available = apps.data?.apps.filter(app => app.status === 'available' && app.appKey) ?? [];

  async function open(app: NativeAppEntry, session?: string) {
    if (pending.current || !app.appKey || (session !== undefined
      && (app.client !== 'copilot' || app.sessionNavigation !== 'available' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(session)))) return;
    pending.current = true;
    setBusy(app.client); setOpeningSession(session !== undefined); setMessage(null);
    try {
      const result = await apiPost<NativeAppOpenResult>('/api/apps/open', { client: app.client, appKey: app.appKey, ...(session !== undefined ? { sessionId: session } : {}) });
      setMessage({ error: false, text: result.message });
    } catch (error) {
      setMessage({ error: true, text: `${(error as Error).message} Check apps again before retrying.` });
      apps.reload();
    } finally { pending.current = false; setBusy(null); setOpeningSession(false); }
  }

  if (!available.length && !apps.error && !message) return null;
  return <section className="panel flex flex-col gap-3" aria-labelledby="native-apps-heading">
    <h2 id="native-apps-heading" className="text-heading">Native apps</h2>
    <p className="text-ui">Open an app with its existing account. Managed profiles and automated tasks for these apps have not been qualified.</p>
    {available.length ? <ul className="flex flex-col gap-3">
      {available.map(app => <li key={app.client} className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0"><p className="font-medium">{app.name}</p>
            {app.version || app.build ? <p className="hint">{app.version ? `Version ${app.version}` : ''}{app.build ? ` · Build ${app.build}` : ''}</p> : null}</div>
          <Button onClick={() => void open(app)} disabled={busy !== null} busy={busy === app.client && !openingSession} busyLabel={`Opening ${app.name}…`}>Open {app.name}</Button>
        </div>
        {app.client === 'copilot' && app.sessionNavigation === 'available' ? <details>
          <summary className="text-ui cursor-pointer">Open an existing Copilot session</summary>
          <form className="mt-3 flex min-w-0 flex-col gap-3" onSubmit={event => { event.preventDefault(); if (sessionValid) void open(app, sessionId); }}>
            <div>
              <label className="field-label" htmlFor={sessionInputId}>Copilot app-local session ID</label>
              <input id={sessionInputId} className="input font-mono" value={sessionId} onChange={event => setSessionId(event.target.value)}
                required pattern="[A-Za-z0-9]([A-Za-z0-9_]|-){0,127}" autoComplete="off" spellCheck={false}
                disabled={busy !== null} aria-invalid={sessionId.length > 0 && !sessionValid ? true : undefined} aria-describedby={`${sessionInputId}-hint`} />
              <p id={`${sessionInputId}-hint`} className="hint">Use the app-local ID. GitHub task and runtime IDs aren’t interchangeable. Use up to 128 letters, numbers, underscores or hyphens; start with a letter or number.</p>
            </div>
            <Button type="submit" className="self-start max-w-full" disabled={busy !== null} busy={busy === app.client && openingSession}
              busyLabel="Opening existing session link…">Open existing session link</Button>
          </form>
        </details> : null}
      </li>)}
    </ul> : null}
    {message ? <p className={message.error ? 'alert-error' : 'notice'} role={message.error ? 'alert' : 'status'}>{message.text}</p> : null}
    {apps.error ? <LoadError error={apps.error} onRetry={apps.reload} /> : <div><Button onClick={apps.reload} disabled={apps.loading || busy !== null}>Check apps again</Button></div>}
  </section>;
}

function ProfileCardView({ profile, canCompare, onClient, onMenu, onCompare }:
  { profile: ProfileCard; canCompare: boolean; onClient: (action: ClientAction) => void; onMenu: (menu: MenuAction) => void; onCompare: () => void }) {
  const info = useInfo();
  const navigate = useNavigate();
  const titleId = useId();
  return (
    <article className="panel flex flex-col gap-4" aria-labelledby={titleId}>
      <div className="flex flex-col gap-1">
        <h2 id={titleId} className="font-mono text-body font-semibold wrap-anywhere">{profile.name}</h2>
        <p className="meta">{clientLabels[profile.client ?? 'codex']} · {profile.signIn} · {profile.binding}</p>
        <p className="text-ui">{profile.summary}</p>
        {profile.state !== 'ready' ? <WarningAlert title={profile.state === 'unbound' ? 'No Codex folder bound' : 'Couldn’t read this profile'}>{profile.reason}</WarningAlert> : null}
      </div>
      {(profile.client ?? 'codex') === 'codex' ? <dl className="grid gap-x-4 gap-y-1 text-ui" style={{ gridTemplateColumns: 'auto 1fr' }}>
        <dt className="muted">Codex CLI</dt><dd>{profile.cli.text}</dd>
        <dt className="muted">Codex Desktop</dt><dd>{profile.desktop.text}</dd>
      </dl> : <div className="flex flex-col gap-2 text-ui">
        <p>{profile.accountScope === 'per-root' ? 'Per-root sign-in: sign in to this profile in Claude Code.'
          : profile.accountScope === 'shared' ? 'Shared account via GitHub CLI (gh-cli). All qualified Copilot profiles use this login.'
          : 'Shared GitHub CLI route: check sign-in to verify this binding before running tasks.'}</p>
        <p className="muted">Account independence: {profile.accountIndependence}.</p>
        {profile.setup ? <Disclosure label="Native setup and sign-in" expandedLabel="Hide native setup">
          <div className="flex flex-col gap-2">
            <p>{profile.client === 'claude-code' ? 'Run this command in Terminal to sign in with your Claude subscription.'
              : 'Sign in to GitHub CLI separately with gh auth login if needed. Run this command to open this profile. A shared login change affects other profiles.'}</p>
            <code className="block font-mono text-ui wrap-anywhere whitespace-pre-wrap">{profile.setup.command}</code>
            <p className="hint">This command uses the currently installed {clientLabels[profile.client ?? 'codex']}. Return here and check sign-in when ready.</p>
          </div>
        </Disclosure> : null}
      </div>}
      <div className="flex flex-wrap gap-2">
        {canCompare ? <Button onClick={onCompare}>Compare with…</Button> : null}
        {profile.moreMenu ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button aria-label={`More actions for ${profile.name}`}>More <span aria-hidden="true">▾</span></Button></DropdownMenuTrigger>
            <DropdownMenuContent aria-label={`More actions for ${profile.name}`}>
              {profile.moreMenu.filter(menu => menu.id === 'copy' ? info?.features.copy : info?.features.profileEdits).map(menu => (
                <DropdownMenuItem key={menu.id} label={menu.label} detail={menu.detail} disabledReason={menu.disabledReason}
                  onSelect={() => menu.id === 'copy' ? navigate(`/profiles/${encodeURIComponent(profile.name)}/copy`) : onMenu(menu)} />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      {info?.features.clientControls && profile.clientActions.length ? (
        <div className="flex flex-wrap gap-2 pt-3 border-t" style={{ borderColor: 'var(--color-divider)' }}>
          {profile.clientActions.map(action => (
            <Button key={action.id} onClick={() => onClient(action)} aria-label={`${action.label.replace(/…$/, '')} for ${profile.name}`}>{action.label}</Button>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function ConflictDialog({ state, onClose, onCheck }: { state: { profile: string; action: ClientAction } | null; onClose: () => void; onCheck: (name: string) => Promise<void> }) {
  const conflict = state?.action.conflict;
  return (
    <Dialog open={Boolean(state)} onOpenChange={open => { if (!open) onClose(); }}>
      {state && conflict ? (
        <DialogContent title={conflict.title} description={conflict.body}>
          <p className="hint">Xenoflux never closes Terminal sessions for you.</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => void onCheck(state.profile)}>Check again</Button>
            <DialogClose asChild><Button>Cancel</Button></DialogClose>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function CompareDialog({ state, names, onClose }: { state: { profile: string } | null; names: string[]; onClose: () => void }) {
  const navigate = useNavigate();
  const others = names.filter(name => name !== state?.profile);
  const [other, setOther] = useState('');
  const id = useId();
  useEffect(() => { setOther(others[0] ?? ''); }, [state?.profile]);
  return (
    <Dialog open={Boolean(state)} onOpenChange={open => { if (!open) onClose(); }}>
      {state ? (
        <DialogContent title={`Compare ${state.profile} with…`}>
          <div>
            <label htmlFor={id} className="field-label">Second profile</label>
            <select id={id} className="input font-mono" value={other} onChange={event => setOther(event.target.value)}>
              {others.map(name => <option key={name} value={name}>{name}</option>)}
            </select>
          </div>
          <p className="hint">{state.profile} becomes the left side. Comparing reads both setups; nothing is copied, activated or signed in.</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={!other} onClick={() => navigate(`/compare/setups?a=${encodeURIComponent(state.profile)}&b=${encodeURIComponent(other)}`)}>Compare setups</Button>
            <DialogClose asChild><Button>Cancel</Button></DialogClose>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function CreateDialog({ open, onClose, sources, onCreated }: { open: boolean; onClose: () => void; sources: Record<ProfileClient, string[]>; onCreated: (text: string) => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [client, setClient] = useState<ProfileClient>('codex');
  const profiles = sources[client];
  const [start, setStart] = useState<'empty' | 'parts'>('empty');
  const [source, setSource] = useState('');
  const from = profiles.includes(source) ? source : profiles[0] ?? '';
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameId = useId(), errorId = useId(), fromId = useId(), clientId = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setName(''); setError(null); setStart('empty'); setClient('codex'); setSource(''); } }, [open]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) { setError('Enter a name for the new profile.'); nameInput.current?.focus(); return; }
    if (start === 'parts' && !from) { setError('Choose a profile to copy from.'); return; }
    setBusy(true); setError(null);
    try {
      if (start === 'parts' || client !== 'codex') {
        const query = new URLSearchParams({ name: name.trim(), client, ...(start === 'parts' ? { from } : {}) });
        navigate(`/profiles/new?${query}`);
      } else {
        const result = await apiPost<{ title: string }>('/api/profiles/new', { name: name.trim(), client, items: [] });
        onCreated(result.title);
      }
    } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={value => { if (!value) onClose(); }}>
      {open ? (
        <DialogContent title="Create a profile">
          <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
            <div>
              <label htmlFor={nameId} className="field-label">Name</label>
              <input ref={nameInput} id={nameId} className="input font-mono" value={name} onChange={event => setName(event.target.value)}
                aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined} autoComplete="off" />
              {error ? <p id={errorId} className="text-ui mt-1" style={{ color: 'var(--color-error)' }}>{error}</p> : null}
            </div>
            <div>
              <label htmlFor={clientId} className="field-label">Client</label>
              <select id={clientId} className="input" value={client} onChange={event => {
                const next = event.target.value as ProfileClient;
                setClient(next);
                setSource('');
                if (!sources[next].length) setStart('empty');
              }}>
                {Object.entries(clientLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select>
              {client === 'copilot' ? <p className="hint">Copilot uses a shared GitHub CLI login once the route is verified.</p> : null}
              {client === 'claude-code' ? <p className="hint">Sign in separately in Claude Code for each profile.</p> : null}
            </div>
            <fieldset className="flex flex-col gap-3">
              <legend className="field-label">Start from</legend>
              <label className="flex gap-3 items-start text-ui">
                <input type="radio" name="start" checked={start === 'empty'} onChange={() => setStart('empty')} />
                <span><span className="font-medium">Empty</span><br /><span className="muted">Set it up in {clientLabels[client]} afterwards.</span></span>
              </label>
              <label className="flex gap-3 items-start text-ui">
                <input type="radio" name="start" checked={start === 'parts'} disabled={!profiles.length} onChange={() => setStart('parts')} />
                <span><span className="font-medium">Selected parts of another profile</span><br /><span className="muted">Choose instructions, skills and settings, and see what the new profile gets before creating it.</span></span>
              </label>
              {start === 'parts' ? (
                <div className="pl-8">
                  <label htmlFor={fromId} className="field-label">Copy parts from</label>
                  <select id={fromId} className="input font-mono" value={from} onChange={event => setSource(event.target.value)}>
                    {profiles.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
              ) : null}
            </fieldset>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="primary" busy={busy} busyLabel="Checking…">{start === 'parts' ? 'Choose parts and preview' : client === 'codex' ? 'Create profile' : 'Review profile'}</Button>
              <DialogClose asChild><Button>Cancel</Button></DialogClose>
            </div>
            <p className="hint">Sign-in, history, memory and plugin connections are never copied. Creating doesn’t open the client.</p>
          </form>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

const EDIT_COPY = {
  add: { title: 'Add an existing Codex folder', field: 'Profile name', second: 'Codex folder', action: 'Add folder', path: '/api/profiles/new', note: 'Xenoflux registers the folder as a profile. It doesn’t move or change its files.' },
  rename: { title: 'Rename profile', field: 'New name', second: null, action: 'Rename', path: 'rename', note: 'Renaming changes how Xenoflux lists the profile. Its files, sign-in and history stay as they are.' },
  binding: { title: 'Change project binding', field: 'Project folder', second: null, action: 'Save binding', path: 'binding', note: 'Binding tells the client which project folder this profile works in. Nothing is copied.' },
  remove: { title: 'Remove from Xenoflux', field: null, second: null, action: 'Remove from Xenoflux', path: 'remove', note: 'Keeps the profile’s files on disk.' },
} as const;

function SimpleEditDialog({ state, onClose, onDone }:
  { state: { kind: 'rename' | 'binding' | 'remove' | 'add'; profile?: string } | null; onClose: () => void; onDone: (text: string, status: StatusKind) => void }) {
  const [value, setValue] = useState('');
  const [second, setSecond] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId(), secondId = useId(), errorId = useId();
  useEffect(() => { setValue(''); setSecond(''); setError(null); }, [state?.kind, state?.profile]);
  if (!state) return <Dialog open={false} />;
  const copy = EDIT_COPY[state.kind];
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!state) return;
    if (copy.field && !value.trim()) { setError(`Enter the ${copy.field.toLowerCase()}.`); return; }
    setBusy(true); setError(null);
    try {
      const body = state.kind === 'rename' ? { newName: value.trim() } : state.kind === 'binding' ? { repository: value.trim() }
        : state.kind === 'add' ? { name: value.trim(), folder: second.trim(), register: true } : {};
      const path = state.kind === 'add' ? copy.path : `/api/profiles/${encodeURIComponent(state.profile ?? '')}/${copy.path}`;
      const result = await apiPost<ClientActionResult & { title?: string }>(path, body);
      onDone(result.message ?? result.title ?? 'Done.', result.status === 'error' ? 'error' : 'success');
    } catch (reason) { setError(reason instanceof ApiError ? reason.message : String(reason)); } finally { setBusy(false); }
  }
  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent title={state.profile ? `${copy.title}: ${state.profile}` : copy.title}>
        <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
          {copy.field ? (
            <div>
              <label htmlFor={id} className="field-label">{copy.field}</label>
              <input id={id} className="input font-mono" value={value} onChange={event => setValue(event.target.value)} autoComplete="off"
                aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined} />
            </div>
          ) : null}
          {copy.second ? (
            <div>
              <label htmlFor={secondId} className="field-label">{copy.second}</label>
              <input id={secondId} className="input font-mono" value={second} onChange={event => setSecond(event.target.value)} autoComplete="off" placeholder="/Users/you/.codex-work" />
            </div>
          ) : null}
          {error ? <ErrorPanel title="Not changed"><span id={errorId}>{error}</span></ErrorPanel> : null}
          <p className="hint">{copy.note}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant={state.kind === 'remove' ? 'destructive' : 'primary'} busy={busy} busyLabel="Saving…">{copy.action}</Button>
            <DialogClose asChild><Button>Cancel</Button></DialogClose>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function StatusLine({ status, text }: { status: StatusKind; text: string }) {
  return <p className="flex flex-wrap gap-2 items-center"><StatusBadge status={status}>{text}</StatusBadge><Link to="/profiles">Back to Profiles</Link></p>;
}
