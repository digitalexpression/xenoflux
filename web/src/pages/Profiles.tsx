import { useCallback, useEffect, useEffectEvent, useId, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ChevronDown } from 'lucide-react';
import { ApiError, apiGet, apiPost } from '@/api/client';
import type { ClientAction, ClientActionResult, MenuAction, NativeSigninAttempt, ProfileCard, ProfileClient, ProfilesView, StatusKind } from '@/api/types';
import { setupInspectHref, setupParams } from '@/components/setup-inventory';
import { Loading, LoadError, Page, PageTitle, useInfo } from '@/components/layout';
import { ErrorPanel, SimulatedNote, WarningAlert } from '@/components/notices';
import { StatusBadge } from '@/components/badges';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useResource } from '@/lib/useResource';

const clientLabels: Record<ProfileClient, string> = { codex: 'Codex', 'claude-code': 'Claude Code', copilot: 'GitHub Copilot' };
const sharedSignIn = 'One sign-in works in CLI and Desktop for this profile.';
const separateSignIns = 'Sign in separately to CLI and Desktop for this profile.';
const clientBusyLabels: Record<string, string> = {
  'open-terminal': 'Opening Terminal…',
  'show-terminal': 'Showing Terminal…',
  'close-terminal': 'Closing CLI…',
  'open-desktop': 'Opening Desktop…',
  'focus-desktop': 'Showing Desktop…',
  'close-desktop': 'Closing Desktop…',
};

type DialogState =
  | { kind: 'conflict'; profile: string; action: ClientAction }
  | { kind: 'create' }
  | { kind: 'add' }
  | { kind: 'rename' | 'binding' | 'remove'; profile: string }
  | null;

export function Profiles() {
  const info = useInfo();
  const [params, setParams] = useSearchParams();
  const [signIn, setSignIn] = useState<{ profile: ProfileCard; heading: HTMLHeadingElement | null } | null>(null);
  const view = useResource(async () => {
    if (info?.mode === 'engine') {
      try { return await apiPost<ProfilesView>('/api/profiles/refresh'); }
      catch (error) {
        if (!(error instanceof ApiError && [404, 405].includes(error.status))) throw error;
      }
    }
    return apiGet<ProfilesView>('/api/profiles');
  }, 'profiles', { live: true, paused: signIn !== null });
  const [dialog, setDialog] = useState<DialogState>(null);
  const editTrigger = useRef<HTMLButtonElement | null>(null);
  const [message, setMessage] = useState<{ status: StatusKind; text: string } | null>(null);
  const pendingClients = useRef(new Set<string>());
  const [busyClients, setBusyClients] = useState<Record<string, string>>({});
  const checkedOnVisit = useRef(new Set<string>());
  const [checkingAccount, setCheckingAccount] = useState<string | null>(null);
  const { data, loading, reload } = view;
  const clientControls = info?.features.clientControls;
  const finishAccountCheck = useEffectEvent((name: string) => {
    pendingClients.current.delete(name);
    if (!signIn) reload();
    setCheckingAccount(null);
  });

  useEffect(() => {
    if (!clientControls || !data || data.simulated || loading || signIn || checkingAccount || document.hidden) return;
    const profile = data.profiles.find(({ name, client, clientActions, accountCheck }) => client
      && (accountCheck ?? (client !== 'codex' && clientActions.some(action => action.id === 'open-terminal')))
      && !checkedOnVisit.current.has(name) && !pendingClients.current.has(name));
    if (!profile) return;

    const { name, client } = profile;
    checkedOnVisit.current.add(name);
    pendingClients.current.add(name);
    setCheckingAccount(name);
    void apiPost(`/api/profiles/${encodeURIComponent(name)}/account`, { client })
      .catch(() => undefined)
      .finally(() => finishAccountCheck(name));
  }, [clientControls, data, loading, signIn, checkingAccount, busyClients]);

  useEffect(() => {
    if (params.get('create')) setDialog({ kind: 'create' });
    else if (params.get('add')) setDialog({ kind: 'add' });
  }, [params]);
  const close = () => { setDialog(null); if (params.size) setParams({}, { replace: true }); };

  async function runClientAction(profile: ProfileCard, action: ClientAction, heading: HTMLHeadingElement | null) {
    if (pendingClients.current.has(profile.name)) return;
    if (action.id === 'signin' && profile.client && profile.client !== 'codex') { setSignIn({ profile, heading }); return; }
    if (action.conflict) { setDialog({ kind: 'conflict', profile: profile.name, action }); return; }
    if (action.id === 'check') checkedOnVisit.current.add(profile.name);
    pendingClients.current.add(profile.name);
    setBusyClients(value => ({ ...value, [profile.name]: action.id }));
    try {
      const result = await apiPost<ClientActionResult>(`/api/profiles/${encodeURIComponent(profile.name)}/clients`, {
        action: action.id,
        ...(action.appKey ? { appKey: action.appKey } : {}),
        ...(action.runId ? { runId: action.runId } : {}),
      });
      setMessage({ status: result.status, text: result.message });
      view.reload();
    } catch (error) { setMessage({ status: 'error', text: (error as Error).message }); }
    finally {
      pendingClients.current.delete(profile.name);
      setBusyClients(value => { const next = { ...value }; delete next[profile.name]; return next; });
      if ((action.id === 'check' || action.id === 'close-terminal') && document.activeElement === document.body) heading?.focus();
    }
  }

  const profileCards = view.data?.profiles ?? [];
  const names = profileCards.filter(p => !p.client || p.client === 'codex').map(p => p.name);
  return (
    <Page current="profiles" title="Profiles">
      <PageTitle title="Profiles"
        subtitle="Codex profiles you create or add share one sign-in across CLI and Desktop. Claude Code and GitHub Copilot require separate sign-ins for CLI and Desktop."
        actions={info?.features.profileEdits ? (
          <>
            <Button onClick={() => { editTrigger.current = null; setDialog({ kind: 'add' }); }}>Add an existing Codex folder…</Button>
            {info.features.create ? <Button variant="primary" onClick={() => setDialog({ kind: 'create' })}>Create profile…</Button> : null}
          </>
        ) : undefined} />
      <div className="profiles-toolbar"><Link to="/setup">Find clients and existing profiles</Link><span className="hint">Profile findings recheck automatically while this page is visible.</span></div>
      {view.data?.simulated ? <SimulatedNote>Client controls and profile changes are simulated; nothing is opened, closed or written.</SimulatedNote> : null}
      {message ? (
        <div role="status" className={message.status === 'error' ? 'alert-error' : message.status === 'success' ? 'alert-success' : 'notice'}>{message.text}</div>
      ) : null}
      {view.error ? <><p className="hint">{view.data ? 'Previous profile findings are shown. Could not refresh; checks retry automatically.' : 'Could not read profiles. Checks retry automatically.'}</p><LoadError error={view.error} onRetry={view.reload} /></> : null}
      {view.loading && !view.data ? <Loading label="Reading profiles…" /> : null}
      {view.data && view.data.profiles.length === 0 ? (
        <div className="panel flex flex-col gap-2">
          <h2 className="text-heading">No profiles yet</h2>
          <p className="muted">Add an existing Codex folder or create a profile. Your normal Codex setup appears as Default once Xenoflux can read it.</p>
        </div>
      ) : null}
      {view.data ? (
        <div className="profile-inventory">
          {(['codex', 'claude-code', 'copilot'] as const).map(client => {
            const profiles = profileCards.filter(profile => (profile.client ?? 'codex') === client);
            return profiles.length ? <section key={client} className="profile-client-group" aria-label={`${clientLabels[client]} profiles`}>
              <div className="profile-group-heading"><h2 className="text-heading">{clientLabels[client]}</h2><span className="hint">{profiles.length} {profiles.length === 1 ? 'profile' : 'profiles'}</span></div>
              <div className="profile-rows">{profiles.map(profile => (
                <ProfileCardView key={profile.name} profile={profile} busyAction={busyClients[profile.name]} checkingAccount={checkingAccount === profile.name}
                  onClient={(action, heading) => runClientAction(profile, action, heading)} onMenu={(menu, trigger) => {
                    if (menu.id === 'copy') return;
                    editTrigger.current = trigger;
                    setDialog({ kind: menu.id, profile: profile.name });
                  }} />
              ))}</div>
            </section> : null;
          })}
        </div>
      ) : null}
      {view.data?.notes.length ? <ul className="hint list-disc pl-5">{view.data.notes.map(note => <li key={note}>{note}</li>)}</ul> : null}

      {signIn ? <SigninDialog profile={signIn.profile} returnFocus={signIn.heading} onClose={() => setSignIn(null)} onRefresh={view.reload} /> : null}

      <ConflictDialog state={dialog?.kind === 'conflict' ? dialog : null} onClose={close}
        onCheck={async name => { await apiPost(`/api/profiles/${encodeURIComponent(name)}/clients`, { action: 'check' }); view.reload(); close(); }} />
      <CreateDialog open={dialog?.kind === 'create'} onClose={close} sources={view.data?.copySources ?? { codex: names, 'claude-code': [], copilot: [] }}
        onCreated={text => { setMessage({ status: 'success', text }); view.reload(); close(); }} />
      <SimpleEditDialog state={dialog && (dialog.kind === 'rename' || dialog.kind === 'binding' || dialog.kind === 'remove' || dialog.kind === 'add') ? dialog : null}
        repositories={dialog?.kind === 'binding' ? profileCards.find(profile => profile.name === dialog.profile)?.repositories : undefined}
        returnFocus={editTrigger.current}
        onClose={close} onDone={(text, status) => { setMessage({ status, text }); view.reload(); close(); }} />
    </Page>
  );
}

const activeSigninStates = new Set<NativeSigninAttempt['state']>(['starting', 'waiting-for-browser', 'verifying']);
const signinLabels: Record<NativeSigninAttempt['state'], string> = {
  starting: 'Starting sign-in…', 'waiting-for-browser': 'Continue in your browser', verifying: 'Verifying sign-in…',
  completed: 'Sign-in verified', failed: 'Sign-in failed', cancelled: 'Sign-in cancelled',
  'timed-out': 'Sign-in timed out', uncertain: 'Sign-in could not be verified',
};

function SigninDialog({ profile, returnFocus, onClose, onRefresh }:
  { profile: ProfileCard; returnFocus: HTMLHeadingElement | null; onClose: () => void; onRefresh: () => void }) {
  const [attempt, setAttempt] = useState<NativeSigninAttempt | null>(null);
  const [busy, setBusy] = useState<'starting' | 'cancelling' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const started = useRef(false);
  const checking = useRef(false);
  const checkGeneration = useRef(0);
  const active = attempt !== null && activeSigninStates.has(attempt.state);
  const clientLabel = clientLabels[profile.client ?? 'codex'];

  function receive(next: NativeSigninAttempt) {
    setAttempt(next); setError(null);
    if (!activeSigninStates.has(next.state)) onRefresh();
  }

  async function check() {
    if (!attempt || pending.current || checking.current) return;
    checking.current = true;
    const generation = checkGeneration.current;
    try {
      const next = await apiGet<NativeSigninAttempt>(`/api/sign-ins/${encodeURIComponent(attempt.id)}`);
      if (!pending.current && generation === checkGeneration.current) receive(next);
    } catch (failure) { if (!pending.current && generation === checkGeneration.current) setError(failure instanceof Error ? failure.message : 'Could not check sign-in.'); }
    finally { checking.current = false; }
  }

  useEffect(() => {
    if (!active || error) return;
    const timer = window.setInterval(() => { void check(); }, 750);
    return () => window.clearInterval(timer);
  });

  async function start() {
    if (pending.current) return;
    pending.current = true; setBusy('starting'); setError(null);
    try { receive(await apiPost<NativeSigninAttempt>(`/api/profiles/${encodeURIComponent(profile.name)}/sign-in`)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not start sign-in.'); }
    finally { pending.current = false; setBusy(null); }
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void start();
  }, []);

  async function dismiss() {
    if (busy) return;
    if (!active || !attempt) { onClose(); return; }
    if (pending.current) return;
    pending.current = true; setBusy('cancelling'); checkGeneration.current++;
    try {
      const next = await apiPost<NativeSigninAttempt>(`/api/sign-ins/${encodeURIComponent(attempt.id)}/cancel`);
      receive(next);
      if (next.state === 'cancelled' || next.state === 'completed') onClose();
      else if (!activeSigninStates.has(next.state)) setError(next.message);
    } catch (failure) { setError(`${failure instanceof Error ? failure.message : 'Could not cancel sign-in.'} Sign-in is still tracked here. Retry the check or cancel again.`); }
    finally { pending.current = false; setBusy(null); }
  }

  return <Dialog open onOpenChange={open => { if (!open) void dismiss(); }}>
    <DialogContent title={`Sign in to ${clientLabel}`} description={`Profile ${profile.name}`}
      onCloseAutoFocus={event => {
        if (attempt?.state === 'completed' && returnFocus?.isConnected) {
          event.preventDefault();
          returnFocus.focus();
        }
      }}>
      <p className="text-ui">{profile.client === 'copilot'
        ? 'Sign in to GitHub for this Copilot CLI profile. Sign in separately in Copilot Desktop.'
        : 'Sign in with your Claude account in your browser. This sign-in belongs to this profile.'}</p>
      <p className="hint">Xenoflux checks sign-in automatically when browser authorization finishes. Never paste passwords, tokens or authorization codes here.</p>
      {busy === 'starting' ? <p role="status">Starting sign-in…</p> : null}
      {attempt ? <div className="flex min-w-0 flex-col gap-3" role="status" aria-live="polite">
        <p className="font-medium">{signinLabels[attempt.state]}</p>
        <p className="text-ui">{attempt.message}</p>
        {active && attempt.deviceCode ? <div><p className="field-label">Enter this code on the vendor’s page</p><code className="font-mono text-body select-all">{attempt.deviceCode}</code></div> : null}
        {active && attempt.browserUrl ? <a className="wrap-anywhere" href={attempt.browserUrl} target="_blank" rel="noreferrer">Open sign-in page in browser</a> : null}
      </div> : null}
      {error ? <p role="alert" className="alert-error">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        {!attempt && error ? <Button variant="primary" onClick={() => void start()} disabled={busy !== null} busy={busy === 'starting'} busyLabel="Starting sign-in…">Start sign in</Button> : null}
        {attempt && error ? <Button onClick={() => void check()} disabled={busy !== null}>Retry sign-in check</Button> : null}
        <Button onClick={() => void dismiss()} disabled={busy !== null} busy={busy === 'cancelling'} busyLabel="Cancelling sign-in…">{active ? 'Cancel sign-in' : 'Close'}</Button>
      </div>
    </DialogContent>
  </Dialog>;
}

function ProfileCardView({ profile, busyAction, checkingAccount, onClient, onMenu }:
  { profile: ProfileCard; busyAction?: string; checkingAccount: boolean; onClient: (action: ClientAction, heading: HTMLHeadingElement | null) => void; onMenu: (menu: MenuAction, trigger: HTMLButtonElement | null) => void }) {
  const info = useInfo();
  const navigate = useNavigate();
  const titleId = useId();
  const handoffHintId = useId();
  const title = useRef<HTMLHeadingElement>(null);
  const retainActionFocus = useCallback((button: HTMLButtonElement | null) => () => {
    if (button && document.activeElement === button) title.current?.focus();
  }, []);
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
  const clientLabel = clientLabels[profile.client ?? 'codex'];
  const cliLabel = profile.client === 'copilot' ? 'Copilot CLI' : clientLabel;
  const signIn = checkingAccount ? 'Checking sign-in…' : profile.signIn;
  const showClaudeHandoff = info?.features.clientControls && profile.client === 'claude-code'
    && (profile.cli.state === 'running' || profile.clientActions.some(action => action.id === 'open-terminal'))
    && (profile.desktop.state === 'running' || profile.clientActions.some(action => action.id === 'open-desktop'));
  return (
    <article className="profile-row min-w-0 wrap-anywhere" aria-labelledby={titleId}>
      <div className="profile-identity">
        <h3 id={titleId} ref={title} tabIndex={-1} className="text-body font-semibold wrap-anywhere">{profile.name}</h3>
        <p className="meta">{clientLabel} · {profile.client === 'copilot' || profile.client === 'claude-code' ? `CLI: ${signIn}` : signIn} · {profile.binding}</p>
        {profile.account ? <p className="text-ui wrap-anywhere">
          <span className="muted">{(profile.client ?? 'codex') === 'codex' && !profile.isDefault ? 'CLI and Desktop account' : 'CLI account'}</span>
          {' · '}{profile.account.label}{profile.account.lastChecked ? ' (last checked)' : ''}
        </p> : null}
        <p className="text-ui">{profile.summary}</p>
        {profile.state !== 'ready' ? <WarningAlert title={profile.state === 'unbound' ? 'No Codex folder bound' : 'Couldn’t read this profile'}>{profile.reason}</WarningAlert> : null}
      </div>
      <div className="profile-runtime">
      {(profile.client ?? 'codex') === 'codex' ? <div className="flex flex-col gap-2 text-ui">
        <dl className="grid gap-x-4 gap-y-1">
          <dt className="muted">Codex CLI</dt><dd>{profile.cli.text}</dd>
          <dt className="muted">Codex Desktop</dt><dd>{profile.desktop.text}</dd>
        </dl>
        {!profile.isDefault && profile.state === 'ready' ? <p className="profile-account-scope">{sharedSignIn}</p> : null}
      </div> : <div className="flex flex-col gap-2 text-ui">
        <dl className="grid gap-x-4 gap-y-1">
          <dt className="muted">{cliLabel}</dt><dd>{profile.cli.text}</dd>
          <dt className="muted">Desktop app</dt><dd>{profile.desktop.text}</dd>
        </dl>
        <p className="profile-account-scope">{separateSignIns}</p>
        <p className="hint">See the Desktop account in the app’s account menu.</p>
        {showClaudeHandoff ? <p id={handoffHintId} className="hint">
          Run <code>/app</code> in Terminal to move your session to Claude Desktop. Xenoflux opens this profile’s Desktop if it’s closed. If prompted, sign in there and retry <code>/app</code>.
        </p> : null}
      </div>}
      </div>
      <div className="profile-inspect-actions">
        <Link to={setupInspectHref({ name: profile.name, client: profile.client ?? 'codex' })}>Inspect setup</Link>
        <Link to={`/sessions/native?${new URLSearchParams({ profile: profile.name, client: profile.client ?? 'codex' })}`}>Inspect sessions</Link>
        <Link to={`/compare/setups?${new URLSearchParams(setupParams({ name: profile.name, client: profile.client ?? 'codex' }))}`}>Compare with…</Link>
        {profile.moreMenu ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button ref={menuTrigger} aria-label={`More actions for ${profile.name}`}>More <ChevronDown size={14} aria-hidden="true" /></Button></DropdownMenuTrigger>
            <DropdownMenuContent aria-label={`More actions for ${profile.name}`}>
              {profile.moreMenu.filter(menu => menu.id === 'copy' ? info?.features.copy : info?.features.profileEdits).map(menu => (
                <DropdownMenuItem key={menu.id} label={menu.label} detail={menu.detail} disabledReason={menu.disabledReason}
                  onSelect={() => menu.id === 'copy' ? navigate(`/profiles/${encodeURIComponent(profile.name)}/copy`) : onMenu(menu, menuTrigger.current)} />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      {info?.features.clientControls && profile.clientActions.length ? (
        <div className="profile-client-actions" role="group" aria-label={`Client actions for ${profile.name}`}>
          {profile.clientActions.map(action => (
            <Button key={action.id === 'check' ? 'signin' : action.id} ref={retainActionFocus}
              onClick={() => onClient(action, title.current)} disabled={Boolean(busyAction)} aria-disabled={checkingAccount || undefined} busy={busyAction === action.id}
              busyLabel={action.id === 'signin' ? (profile.client && profile.client !== 'codex' ? 'Starting sign-in…' : 'Opening Terminal…')
                : clientBusyLabels[action.id] ?? 'Checking…'}
              aria-describedby={showClaudeHandoff && action.id === 'open-terminal' ? handoffHintId : undefined}
              aria-label={`${action.label.replace(/…$/, '')} for ${profile.name}`}>{action.label}</Button>
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

function CreateDialog({ open, onClose, sources, onCreated }: { open: boolean; onClose: () => void; sources: Record<ProfileClient, string[]>; onCreated: (text: string) => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [client, setClient] = useState<ProfileClient>('codex');
  const profiles = sources[client];
  const [start, setStart] = useState<'empty' | 'parts'>('empty');
  const [source, setSource] = useState('');
  const from = source;
  const sourceAvailable = profiles.includes(from);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameId = useId(), errorId = useId(), fromId = useId(), clientId = useId(), signInHintId = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setName(''); setError(null); setStart('empty'); setClient('codex'); setSource(''); } }, [open]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) { setError('Enter a name for the new profile.'); nameInput.current?.focus(); return; }
    if (start === 'parts' && !sourceAvailable) { setError('Choose a profile to copy from.'); return; }
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
              <select id={clientId} className="input" aria-describedby={signInHintId} value={client} onChange={event => {
                const next = event.target.value as ProfileClient;
                setClient(next);
                setSource(sources[next][0] ?? '');
                if (!sources[next].length) setStart('empty');
              }}>
                {Object.entries(clientLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select>
              <p id={signInHintId} className="hint">{client === 'codex' ? sharedSignIn : separateSignIns}</p>
            </div>
            <fieldset className="flex flex-col gap-3">
              <legend className="field-label">Start from</legend>
              <label className="flex gap-3 items-start text-ui">
                <input type="radio" name="start" checked={start === 'empty'} onChange={() => setStart('empty')} />
                <span><span className="font-medium">Empty</span><br /><span className="muted">Set it up in {clientLabels[client]} afterwards.</span></span>
              </label>
              <label className="flex gap-3 items-start text-ui">
                <input type="radio" name="start" checked={start === 'parts'} disabled={!profiles.length} onChange={() => { setStart('parts'); if (!source) setSource(profiles[0] ?? ''); }} />
                <span><span className="font-medium">Selected parts of another profile</span><br /><span className="muted">Choose instructions, skills and settings, and see what the new profile gets before creating it.</span></span>
              </label>
              {start === 'parts' ? (
                <div className="pl-8">
                  <label htmlFor={fromId} className="field-label">Copy parts from</label>
                  <select id={fromId} className="input font-mono" value={from} aria-invalid={!sourceAvailable || undefined} aria-describedby={!sourceAvailable ? `${fromId}-unavailable` : undefined} onChange={event => setSource(event.target.value)}>
                    {!sourceAvailable ? <option value={from} disabled>{from ? `${from} (unavailable)` : 'Choose a profile'}</option> : null}
                    {profiles.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                  {!sourceAvailable ? <p id={`${fromId}-unavailable`} className="hint">This source is no longer available. Choose another profile before continuing.</p> : null}
                </div>
              ) : null}
            </fieldset>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="primary" disabled={start === 'parts' && !sourceAvailable} busy={busy} busyLabel="Checking…">{start === 'parts' ? 'Choose parts and preview' : client === 'codex' ? 'Create profile' : 'Review profile'}</Button>
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
  binding: { title: 'Change project binding', field: 'Project folder', second: null, action: 'Save binding', path: 'binding', note: 'Bindings point to project folders. Removing a binding keeps the folder and its files.' },
  remove: { title: 'Remove from Xenoflux', field: null, second: null, action: 'Remove from Xenoflux', path: 'remove', note: 'Keeps the profile’s files on disk.' },
} as const;

type EditSubmission = { kind: 'form' } | { kind: 'unbind'; repository: string };

function SimpleEditDialog({ state, repositories = [], returnFocus, onClose, onDone }:
  { state: { kind: 'rename' | 'binding' | 'remove' | 'add'; profile?: string } | null; repositories?: string[];
    returnFocus: HTMLButtonElement | null; onClose: () => void; onDone: (text: string, status: StatusKind) => void }) {
  const [value, setValue] = useState('');
  const [second, setSecond] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<EditSubmission | null>(null);
  const id = useId(), secondId = useId(), errorId = useId();
  useEffect(() => { setValue(''); setSecond(''); setError(null); }, [state?.kind, state?.profile]);
  if (!state) return <Dialog open={false} />;
  const copy = EDIT_COPY[state.kind];
  const profilePath = `/api/profiles/${encodeURIComponent(state.profile ?? '')}`;
  async function save(path: string, body: unknown, submission: EditSubmission) {
    if (saving) return;
    setSaving(submission);
    setError(null);
    try {
      const result = await apiPost<ClientActionResult & { title?: string }>(path, body);
      onDone(result.message ?? result.title ?? 'Done.', result.status === 'error' ? 'error' : 'success');
    } catch (reason) { setError(reason instanceof ApiError ? reason.message : String(reason)); } finally { setSaving(null); }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!state) return;
    if (copy.field && !value.trim()) { setError(`Enter the ${copy.field.toLowerCase()}.`); return; }
    const body = state.kind === 'rename' ? { newName: value.trim() } : state.kind === 'binding' ? { repository: value.trim() }
      : state.kind === 'add' ? { name: value.trim(), folder: second.trim(), register: true } : {};
    const path = state.kind === 'add' ? copy.path : `${profilePath}/${copy.path}`;
    await save(path, body, { kind: 'form' });
  }
  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent title={state.profile ? `${copy.title}: ${state.profile}` : copy.title}
        onCloseAutoFocus={event => { if (returnFocus?.isConnected) { event.preventDefault(); returnFocus.focus(); } }}>
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
          {state.kind === 'binding' && repositories.length ? <div className="flex flex-col gap-2">
            <p className="field-label">Bound project folders</p>
            <ul className="flex flex-col gap-2">
              {repositories.map(repository => <li key={repository} className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <code className="min-w-0 wrap-anywhere text-ui">{repository}</code>
                <Button disabled={Boolean(saving)} busy={saving?.kind === 'unbind' && saving.repository === repository}
                  busyLabel="Removing binding…" aria-label={`Remove binding for ${repository}`}
                  onClick={() => void save(`${profilePath}/unbind`, { repository }, { kind: 'unbind', repository })}>Remove binding</Button>
              </li>)}
            </ul>
          </div> : null}
          <p className="hint">{copy.note}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant={state.kind === 'remove' ? 'destructive' : 'primary'}
              disabled={saving?.kind === 'unbind'} busy={saving?.kind === 'form'} busyLabel="Saving…">{copy.action}</Button>
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
