import { Fragment, useCallback, useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { MouseEvent, RefObject } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ChevronDown, CircleCheck, CircleX, Ellipsis, FolderOpen, LogIn, Monitor, PanelRight, Play, Plus, RefreshCw, ScanLine, Square, Terminal, TriangleAlert, X } from 'lucide-react';
import { ApiError, apiGet, apiPost } from '@/api/client';
import type { ClientAction, ClientActionResult, ClientInfo, ClientState, MenuAction, NativeSigninAttempt, ProfileCard, ProfileClient, ProfilesView, StatusKind } from '@/api/types';
import { setupInspectHref, setupParams } from '@/components/setup-inventory';
import { Loading, LoadError, Page, useInfo } from '@/components/layout';
import { ErrorPanel, SimulatedNote, WarningAlert } from '@/components/notices';
import { ProfileDiscovery } from '@/components/profile-discovery';
import { StatusBadge } from '@/components/badges';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import { Tooltip } from '@/components/ui/tooltip';
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
  'refresh-signin': 'Updating sign-in status…',
};

type SurfaceState = 'open' | 'closed' | 'unknown' | 'unavailable';
const surfaceStates: Record<ClientState, SurfaceState> = { running: 'open', 'not-running': 'closed', unknown: 'unknown', unavailable: 'unavailable' };
const surfaceLabels: Record<SurfaceState, string> = { open: 'Open', closed: 'Closed', unknown: 'Unknown', unavailable: 'Unavailable' };
const accountLabels: Record<NonNullable<ProfileCard['accountFinding']>['state'], string> = {
  'signed-in': 'Signed in', 'signed-out': 'Sign in required', saved: 'Sign-in saved', unverified: 'Sign in required', unchecked: 'Sign-in not checked',
};

type CardActivity = { kind: 'idle' } | { kind: 'checking-account' } | { kind: 'signing-in' } | { kind: 'action'; id: string };
type DesktopBlocker = { guidance: string; processes: string[]; command?: string };
type CardNotice = { status: StatusKind; text: string; blocker?: DesktopBlocker };

function readDesktopBlocker(error: unknown): DesktopBlocker | undefined {
  if (!(error instanceof ApiError) || !['profile-operation-busy', 'desktop-resources-busy'].includes(error.code)) return;
  const details = error.details;
  if (!details || typeof details !== 'object' || !('guidance' in details) || typeof details.guidance !== 'string'
    || !('processes' in details) || !Array.isArray(details.processes)
    || !details.processes.every((name): name is string => typeof name === 'string')) return;
  return { guidance: details.guidance, processes: details.processes,
    ...('command' in details && typeof details.command === 'string' ? { command: details.command } : {}) };
}
type ClientIcons = Partial<Record<ProfileClient, string | null>>;
const clientInitials: Record<ProfileClient, string> = { codex: 'Cx', 'claude-code': 'Cl', copilot: 'Gh' };
const cardKey = (profile: ProfileCard) => `${profile.client ?? 'codex'}:${profile.name}`;
function accountFreshness(profile: ProfileCard) {
  if (!profile.client || profile.client === 'codex') return 'current';
  if (profile.accountFinding?.lastChecked) return 'stale';
  return profile.accountFinding?.state === 'unchecked' ? 'unchecked' : 'current';
}
const desktopActions = new Set(['open-desktop', 'focus-desktop', 'close-desktop']);
const primaryClientActions = new Set(['open-terminal', 'show-terminal', 'open-desktop', 'focus-desktop']);
const actionIcons: Partial<Record<string, typeof Play>> = {
  'open-terminal': Play, 'open-desktop': Play, 'show-terminal': Terminal, 'focus-desktop': Monitor,
  'close-terminal': Square, 'close-desktop': Square, signin: LogIn,
};
const inspectorDockQuery = '(min-width: 800px)';
const canDockInspector = () => window.matchMedia(inspectorDockQuery).matches;
function subscribeInspectorDock(update: () => void) {
  const query = window.matchMedia(inspectorDockQuery);
  query.addEventListener('change', update);
  return () => query.removeEventListener('change', update);
}

type ProfileSelection = {
  key: string;
  trigger: HTMLButtonElement;
  fallback: HTMLButtonElement | null;
  focusInspector: boolean;
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
  const [checkingAccount, setCheckingAccount] = useState<string | null>(null);
  const [busyClients, setBusyClients] = useState<Record<string, string>>({});
  const view = useResource(async () => {
    if (info?.mode === 'engine') {
      try { return await apiPost<ProfilesView>('/api/profiles/refresh'); }
      catch (error) {
        if (!(error instanceof ApiError && [404, 405].includes(error.status))) throw error;
      }
    }
    return apiGet<ProfilesView>('/api/profiles');
  }, 'profiles', { live: true, paused: signIn !== null || checkingAccount !== null || Object.keys(busyClients).length > 0 });
  const [dialog, setDialog] = useState<DialogState>(null);
  const pageHeading = useRef<HTMLHeadingElement>(null);
  const addProfileTrigger = useRef<HTMLButtonElement>(null);
  const editTrigger = useRef<HTMLButtonElement | null>(null);
  const [message, setMessage] = useState<{ status: StatusKind; text: string } | null>(null);
  const [cardNotices, setCardNotices] = useState<Partial<Record<string, CardNotice>>>({});
  const pendingClients = useRef(new Set<string>());
  const checkedOnVisit = useRef(new Map<string, ReturnType<typeof accountFreshness>>());
  const [selection, setSelection] = useState<ProfileSelection | null>(null);
  const inspectorId = useId();
  const inspectorCloseButton = useRef<HTMLButtonElement>(null);
  const dockInspector = useSyncExternalStore(subscribeInspectorDock, canDockInspector);
  const [revealing, setRevealing] = useState<string | null>(null);
  const [icons, setIcons] = useState<ClientIcons>({});
  const { data, loading, reload } = view;
  const clientControls = info?.features.clientControls;
  const finishAccountCheck = useEffectEvent(async (key: string, checked: boolean) => {
    if (checked && !signIn) await reload();
    pendingClients.current.delete(key);
    setCheckingAccount(null);
  });

  useEffect(() => {
    if (!clientControls || !data || data.simulated || loading || signIn || checkingAccount || document.hidden) return;
    for (const profile of data.profiles) {
      const key = cardKey(profile);
      if (accountFreshness(profile) === 'current' && checkedOnVisit.current.has(key))
        checkedOnVisit.current.set(key, 'current');
    }
    const profile = data.profiles.find(candidate => candidate.client
      && (candidate.accountCheck ?? (candidate.client !== 'codex' && candidate.clientActions.some(action => action.id === 'open-terminal')))
      && checkedOnVisit.current.get(cardKey(candidate)) !== accountFreshness(candidate)
      && !pendingClients.current.has(cardKey(candidate)));
    if (!profile) return;

    const { name, client } = profile;
    const key = cardKey(profile);
    checkedOnVisit.current.set(key, accountFreshness(profile));
    pendingClients.current.add(key);
    setCheckingAccount(key);
    void apiPost(`/api/profiles/${encodeURIComponent(name)}/account`, { client })
      .then(() => finishAccountCheck(key, true), () => finishAccountCheck(key, false));
  }, [clientControls, data, loading, signIn, checkingAccount, busyClients]);

  useEffect(() => {
    pageHeading.current?.focus();
    let current = true;
    apiGet<ClientIcons>('/api/clients/icons').then(value => { if (current) setIcons(value); }, () => undefined);
    return () => { current = false; };
  }, []);

  useEffect(() => {
    if (selection && data && !data.profiles.some(profile => cardKey(profile) === selection.key)) setSelection(null);
  }, [selection, data]);

  useLayoutEffect(() => {
    if (selection?.focusInspector) inspectorCloseButton.current?.focus();
  }, [selection]);

  useEffect(() => {
    if (params.get('create')) setDialog({ kind: 'create' });
    else if (params.get('add')) setDialog({ kind: 'add' });
  }, [params]);
  const close = () => { setDialog(null); if (params.size) setParams({}, { replace: true }); };
  const reportCard = (profile: ProfileCard, notice?: CardNotice) =>
    setCardNotices(current => ({ ...current, [cardKey(profile)]: notice }));

  async function refreshCardNotice(profile: ProfileCard, notice?: CardNotice) {
    const updated = await reload();
    reportCard(profile, !updated && notice?.status === 'success'
      ? { status: 'warning', text: `${notice.text} Couldn’t refresh the profile status.` } : notice);
  }

  function finishClientAction(key: string) {
    pendingClients.current.delete(key);
    setBusyClients(value => { const next = { ...value }; delete next[key]; return next; });
  }

  async function refreshAfterSignin(profile: ProfileCard, notice?: CardNotice) {
    const key = cardKey(profile);
    pendingClients.current.add(key);
    setBusyClients(value => ({ ...value, [key]: 'refresh-signin' }));
    try { await refreshCardNotice(profile, notice); }
    finally { finishClientAction(key); }
  }

  async function runClientAction(profile: ProfileCard, action: ClientAction, heading: HTMLHeadingElement | null) {
    const key = cardKey(profile);
    if (pendingClients.current.has(key)) return;
    if (action.conflict) { setDialog({ kind: 'conflict', profile: profile.name, action }); return; }
    reportCard(profile);
    if (action.id === 'signin' && profile.client && profile.client !== 'codex') { setSignIn({ profile, heading }); return; }
    pendingClients.current.add(key);
    setBusyClients(value => ({ ...value, [key]: action.id }));
    try {
      const notice = await apiPost<ClientActionResult>(`/api/profiles/${encodeURIComponent(profile.name)}/clients`, {
        action: action.id,
        ...(profile.isDefault && profile.client ? { client: profile.client } : {}),
        ...(action.appKey ? { appKey: action.appKey } : {}),
        ...(action.runId ? { runId: action.runId } : {}),
      }).then<CardNotice, CardNotice>(result => ({ status: result.status, text: result.message }),
        (error: unknown) => ({ status: 'error', text: error instanceof Error ? error.message : 'Client action failed.', blocker: readDesktopBlocker(error) }));
      await refreshCardNotice(profile, notice);
    } finally {
      finishClientAction(key);
      if (action.id === 'close-terminal' && document.activeElement === document.body) heading?.focus();
    }
  }

  async function revealFolder(profile: ProfileCard) {
    if (revealing) return;
    reportCard(profile);
    setRevealing(cardKey(profile));
    try {
      const result = await apiPost<ClientActionResult>(`/api/profiles/${encodeURIComponent(profile.name)}/reveal`, { client: profile.client ?? 'codex' });
      reportCard(profile, { status: result.status, text: result.message });
    } catch (error) { reportCard(profile, { status: 'error', text: error instanceof Error ? error.message : 'Could not show the folder.' }); }
    finally { setRevealing(null); }
  }

  const activityFor = (key: string): CardActivity => {
    if (busyClients[key]) return { kind: 'action', id: busyClients[key] };
    if (signIn && cardKey(signIn.profile) === key) return { kind: 'signing-in' };
    if (checkingAccount === key) return { kind: 'checking-account' };
    return { kind: 'idle' };
  };
  const closeInspector = (returnFocus?: HTMLButtonElement) => {
    const trigger = selection?.trigger;
    const fallback = selection?.fallback;
    setSelection(null);
    (returnFocus ?? (trigger?.isConnected ? trigger : fallback))?.focus();
  };
  const inspect = (key: string, event: MouseEvent<HTMLButtonElement>, fallback: HTMLButtonElement | null = event.currentTarget) => {
    const trigger = event.currentTarget;
    if (selection?.key === key && trigger === fallback) closeInspector(trigger);
    else setSelection({ key, trigger, fallback, focusInspector: event.detail === 0 });
  };
  const profileCards = view.data?.profiles ?? [];
  const inspectedProfile = selection ? profileCards.find(profile => cardKey(profile) === selection.key) : undefined;
  const inspector = inspectedProfile ? <ProfileInspector id={inspectorId} closeButton={inspectorCloseButton} onClose={() => closeInspector()}
    profile={inspectedProfile} notice={cardNotices[cardKey(inspectedProfile)]} revealing={revealing === cardKey(inspectedProfile)}
    onReveal={() => void revealFolder(inspectedProfile)} /> : <ProfileGuide canAdd={Boolean(info?.features.profileEdits)} />;
  const names = profileCards.filter(p => !p.client || p.client === 'codex').map(p => p.name);
  return (
    <Page current="profiles" title="Profiles" toolbarActions={info?.features.profileEdits ? (
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={!view.data}>
          <Button ref={addProfileTrigger} variant="primary" className="btn-sm"><Plus size={16} aria-hidden="true" />Add a profile</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" aria-label="Add a profile"
          onCloseAutoFocus={event => { if (dialog?.kind === 'create' || dialog?.kind === 'add') event.preventDefault(); }}>
          {info.features.create ? <DropdownMenuItem label="Create profile" onSelect={() => setDialog({ kind: 'create' })} /> : null}
          <DropdownMenuItem label="Add existing profile folder" onSelect={() => setDialog({ kind: 'add' })} />
        </DropdownMenuContent>
      </DropdownMenu>
    ) : undefined}>
      <h1 ref={pageHeading} tabIndex={-1} className="sr-only">Profiles</h1>
      {view.data?.simulated ? <SimulatedNote>Client controls and profile changes are simulated; nothing is opened, closed or written.</SimulatedNote> : null}
      {message ? (
        <div role="status" className={message.status === 'error' ? 'alert-error' : message.status === 'success' ? 'alert-success' : 'notice'}>{message.text}</div>
      ) : null}
      <div className="profiles-workspace" data-docked={dockInspector || undefined}
        onKeyDown={event => {
          if (event.key !== 'Escape' || event.defaultPrevented || !inspectedProfile || !(event.target instanceof HTMLElement)) return;
          if (event.target.closest('.profile-inspector') || event.target === selection?.trigger || event.target === selection?.fallback) {
            event.preventDefault();
            closeInspector();
          }
        }}>
        <div className="profile-inventory">
          {view.error && !view.data ? <LoadError error={view.error} onRetry={view.reload} /> : null}
          {view.loading && !view.data ? <Loading label="Reading profiles…" /> : null}
          {view.data && profileCards.length === 0 ? <div className="panel flex flex-col gap-2">
            <h2 className="text-heading">No profiles yet</h2>
            <p className="muted">Your standard setup appears as Default once Xenoflux can read it.</p>
          </div> : null}
          {(['codex', 'claude-code', 'copilot'] as const).map(client => {
            const profiles = profileCards.filter(profile => (profile.client ?? 'codex') === client);
            return profiles.length ? <section key={client} className="profile-client-group" aria-label={`${clientLabels[client]} profiles`}>
              <div className="profile-group-heading"><h2 className="text-heading">{clientLabels[client]}</h2><span className="hint">{profiles.length} {profiles.length === 1 ? 'profile' : 'profiles'}</span></div>
              <div className="profile-grid">{profiles.map(profile => {
                const key = cardKey(profile);
                const selected = selection?.key === key;
                return <Fragment key={key}>
                  <ProfileCardView profile={profile} icon={icons[client] ?? null} activity={activityFor(key)}
                    notice={cardNotices[key]} revealing={revealing === key} onReveal={() => void revealFolder(profile)}
                    inspectorId={selected ? inspectorId : undefined} onInspect={(event, fallback) => inspect(key, event, fallback)}
                    onClient={(action, heading) => runClientAction(profile, action, heading)} onMenu={(menu, trigger) => {
                      if (menu.id === 'copy') return;
                      editTrigger.current = trigger;
                      setDialog({ kind: menu.id, profile: profile.name });
                    }} />
                  {selected && !dockInspector ? inspector : null}
                </Fragment>;
              })}</div>
            </section> : null;
          })}
        </div>
        {dockInspector || !inspectedProfile ? inspector : null}
      </div>
      {view.error && view.data ? <ErrorPanel title="Couldn’t refresh profiles" actions={<Button onClick={view.reload}>Try again</Button>}>
        <span role="status">Showing previous profile findings.</span> {view.error.message} Checks retry automatically.
      </ErrorPanel> : null}
      <ClientDiscoveryCard icons={icons} />

      {signIn ? <SigninDialog profile={signIn.profile} returnFocus={signIn.heading} onClose={() => setSignIn(null)}
        onRefresh={notice => refreshAfterSignin(signIn.profile, notice)}
        onResult={notice => reportCard(signIn.profile, notice)} /> : null}

      <ConflictDialog state={dialog?.kind === 'conflict' ? dialog : null} onClose={close}
        onCheck={async name => { await apiPost(`/api/profiles/${encodeURIComponent(name)}/clients`, { action: 'check' }); view.reload(); close(); }} />
      <CreateDialog open={dialog?.kind === 'create'} onClose={close} returnFocus={addProfileTrigger} sources={view.data?.copySources ?? { codex: names, 'claude-code': [], copilot: [] }}
        onCreated={text => { setMessage({ status: 'success', text }); view.reload(); close(); }} />
      <SimpleEditDialog state={dialog && (dialog.kind === 'rename' || dialog.kind === 'binding' || dialog.kind === 'remove' || dialog.kind === 'add') ? dialog : null}
        repositories={dialog?.kind === 'binding' ? profileCards.find(profile => profile.name === dialog.profile)?.repositories : undefined}
        returnFocus={dialog?.kind === 'add' ? addProfileTrigger.current : editTrigger.current}
        onClose={close} onDone={(text, status) => { setMessage({ status, text }); view.reload(); close(); }} />
    </Page>
  );
}

function ClientDiscoveryCard({ icons }: { icons: ClientIcons }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <div className="profile-discovery-card">
    <button type="button" className="profile-discovery-toggle" aria-label={`${open ? 'Hide' : 'Show'} client discovery`}
      aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      <ScanLine size={16} aria-hidden="true" />
      <span>Client discovery</span>
      <span className="profile-discovery-icons" aria-hidden="true">
        {(['codex', 'claude-code', 'copilot'] as const).map(client => <ProfileClientIcon key={client} client={client} icon={icons[client]} />)}
      </span>
      <ChevronDown size={16} className="profile-discovery-chevron" aria-hidden="true" />
    </button>
    <div id={id} hidden={!open}>{open ? <ProfileDiscovery /> : null}</div>
  </div>;
}

function ProfileGuide({ canAdd }: { canAdd: boolean }) {
  const id = useId();
  return <aside className="profile-inspector profile-guide" aria-labelledby={id}>
    <header className="profile-inspector-header"><h2 id={id} className="text-body font-semibold">Profiles guide</h2></header>
    <ul className="profile-inspector-body profile-guide-steps">
      {canAdd ? <li><Plus size={16} aria-hidden="true" /><div><strong>Add a profile</strong><p>Create one or add an existing folder from the toolbar.</p></div></li> : null}
      <li><Play size={16} aria-hidden="true" /><div><strong>Open a client</strong><p>Use the CLI or Desktop row on a profile.</p></div></li>
      <li><PanelRight size={16} aria-hidden="true" /><div><strong>Inspect a profile</strong><p>Open Details for accounts, folders, and setup.</p></div></li>
    </ul>
  </aside>;
}

function ProfileClientIcon({ client, icon }: { client: ProfileClient; icon?: string | null }) {
  return icon ? <img className="profile-app-icon" src={icon} alt="" width={32} height={32} />
    : <span className="profile-app-icon" aria-hidden="true">{clientInitials[client]}</span>;
}

const activeSigninStates = new Set<NativeSigninAttempt['state']>(['starting', 'waiting-for-browser', 'verifying']);
const signinLabels: Record<NativeSigninAttempt['state'], string> = {
  starting: 'Starting sign-in…', 'waiting-for-browser': 'Continue in your browser', verifying: 'Verifying sign-in…',
  completed: 'Sign-in verified', failed: 'Sign-in failed', cancelled: 'Sign-in cancelled',
  'timed-out': 'Sign-in timed out', uncertain: 'Sign-in could not be verified',
};

function SigninDialog({ profile, returnFocus, onClose, onRefresh, onResult }:
  { profile: ProfileCard; returnFocus: HTMLHeadingElement | null; onClose: () => void; onRefresh: (notice?: CardNotice) => Promise<void>;
    onResult: (notice?: CardNotice) => void }) {
  const [attempt, setAttempt] = useState<NativeSigninAttempt | null>(null);
  const [busy, setBusy] = useState<'starting' | 'cancelling' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const started = useRef(false);
  const checking = useRef(false);
  const checkGeneration = useRef(0);
  const active = attempt !== null && activeSigninStates.has(attempt.state);
  const clientLabel = clientLabels[profile.client ?? 'codex'];

  async function receive(next: NativeSigninAttempt) {
    setAttempt(next); setError(null);
    if (activeSigninStates.has(next.state)) return;
    if (next.state === 'completed') await onRefresh({ status: 'success', text: signinLabels.completed });
    else if (next.state === 'cancelled') await onRefresh();
    else await onRefresh({ status: next.state === 'uncertain' ? 'warning' : 'error', text: next.message });
  }

  async function check() {
    if (!attempt || pending.current || checking.current) return;
    checking.current = true;
    const generation = checkGeneration.current;
    try {
      const next = await apiGet<NativeSigninAttempt>(`/api/sign-ins/${encodeURIComponent(attempt.id)}`);
      if (!pending.current && generation === checkGeneration.current) await receive(next);
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
    onResult();
    try { await receive(await apiPost<NativeSigninAttempt>(`/api/profiles/${encodeURIComponent(profile.name)}/sign-in`)); }
    catch (failure) {
      const text = failure instanceof Error ? failure.message : 'Could not start sign-in.';
      setError(text);
      onResult({ status: 'error', text });
    }
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
      await receive(next);
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

function SurfaceDot({ state }: { state: SurfaceState }) {
  return <span className="surface-dot" data-state={state} aria-hidden="true" />;
}

function Spinner() {
  return <span className="profile-spinner" aria-hidden="true" />;
}

function surfaceRows(profile: ProfileCard): { label: string; info: ClientInfo; name: string }[] {
  const codex = (profile.client ?? 'codex') === 'codex';
  return [
    { label: 'CLI', info: profile.cli, name: codex ? 'Codex CLI' : profile.client === 'copilot' ? 'Copilot CLI' : clientLabels[profile.client ?? 'codex'] },
    { label: 'Desktop', info: profile.desktop, name: codex ? 'Codex Desktop' : 'Desktop app' },
  ];
}

function accountScope(profile: ProfileCard) {
  return (profile.client ?? 'codex') === 'codex' && !profile.isDefault ? 'CLI and Desktop account' : 'CLI account';
}

function warningTitle(profile: ProfileCard) {
  return profile.state === 'unbound' ? 'No Codex folder bound' : 'Couldn’t read this profile';
}

function showClaudeHints(profile: ProfileCard, clientControls: boolean | undefined) {
  const desktop = Boolean(clientControls) && profile.client === 'claude-code'
    && (profile.desktop.state === 'running' || profile.clientActions.some(action => action.id === 'open-desktop'));
  return { desktop, handoff: desktop && (profile.cli.state === 'running' || profile.clientActions.some(action => action.id === 'open-terminal')) };
}

const claudeDesktopSignInHint = 'Quit all other Claude Desktop instances before signing in to this profile. After signing in, quit this profile, open regular Claude Desktop first, then reopen this profile from Xenoflux.';
const claudeHandoffHint = <>Run <code>/app</code> in Terminal to move your session to Claude Desktop. Xenoflux opens this profile’s Desktop if it’s closed. If prompted, sign in there and retry <code>/app</code>.</>;

function ProfileCardView({ profile, icon, activity, notice, revealing, inspectorId, onClient, onMenu, onInspect, onReveal }:
  { profile: ProfileCard; icon: string | null; activity: CardActivity; notice?: CardNotice; revealing: boolean; onReveal: () => void;
    inspectorId?: string;
    onClient: (action: ClientAction, heading: HTMLHeadingElement | null) => void; onMenu: (menu: MenuAction, trigger: HTMLButtonElement | null) => void;
    onInspect: (event: MouseEvent<HTMLButtonElement>, fallback?: HTMLButtonElement | null) => void }) {
  const info = useInfo();
  const navigate = useNavigate();
  const titleId = useId();
  const handoffHintId = useId();
  const desktopSignInHintId = useId();
  const title = useRef<HTMLHeadingElement>(null);
  const retainActionFocus = useCallback((button: HTMLButtonElement | null) => () => {
    if (button && document.activeElement === button) title.current?.focus();
  }, []);
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
  const detailsTrigger = useRef<HTMLButtonElement | null>(null);
  const client = profile.client ?? 'codex';
  const clientLabel = clientLabels[client];
  const hints = showClaudeHints(profile, info?.features.clientControls);
  const checkingAccount = activity.kind === 'checking-account';
  const busyAction = activity.kind === 'action' ? activity.id : undefined;
  const working = activity.kind === 'signing-in' ? 'Signing in…'
    : busyAction === 'signin' ? 'Opening Terminal…'
    : busyAction ? clientBusyLabels[busyAction] ?? 'Working…'
    : revealing ? 'Showing in Finder…' : null;
  const problem: CardNotice | undefined = profile.state === 'ready' ? undefined
    : { status: profile.state === 'unbound' ? 'warning' : 'error', text: warningTitle(profile) };
  const feedback = notice?.status === 'error' || notice?.status === 'warning' ? notice
    : problem ?? notice ?? (working ? { status: 'neutral' as const, text: working } : { status: 'idle' as const, text: 'Auto-checks on' });
  const showDetails = feedback.status === 'warning' || feedback.status === 'error';
  const NoticeIcon = feedback.status === 'error' ? CircleX : feedback.status === 'warning' ? TriangleAlert
    : feedback.status === 'success' ? CircleCheck : feedback.status === 'idle' ? RefreshCw : null;
  const sharedAccount = client === 'codex' && !profile.isDefault && profile.state === 'ready';
  const accountText = profile.account?.label ?? (profile.accountFinding ? accountLabels[profile.accountFinding.state] : profile.signIn);
  const lastChecked = profile.accountFinding?.lastChecked ?? profile.account?.lastChecked;
  const desktopAccount = sharedAccount ? 'Same account as CLI' : profile.state === 'ready' ? 'Account in Desktop' : 'Account unavailable';
  return (
    <article className="profile-card" aria-labelledby={titleId} data-selected={Boolean(inspectorId) || undefined}>
      <div className="profile-card-header">
        <ProfileClientIcon client={client} icon={icon} />
        <div className="profile-card-title">
          <h3 id={titleId} ref={title} tabIndex={-1} title={profile.name} className="text-body font-semibold truncate">{profile.name}</h3>
          <p className="meta truncate">{clientLabel} · {profile.binding}</p>
        </div>
        <div className="profile-card-tools">
          {profile.folder && info?.features.clientControls ? <Tooltip content={<>Show in Finder<br />{profile.folder}</>}>
            <Button size="icon" className="btn-sm" aria-label={`Show ${profile.name} folder in Finder`} aria-busy={revealing || undefined}
              onClick={() => { if (!revealing) onReveal(); }}><FolderOpen size={16} aria-hidden="true" /></Button>
          </Tooltip> : null}
          <Button ref={detailsTrigger} size="icon" className="btn-sm profile-card-details" aria-label={`Details for ${profile.name}`}
            aria-expanded={Boolean(inspectorId)} aria-controls={inspectorId} onClick={event => onInspect(event)}>
            <PanelRight size={16} aria-hidden="true" />
          </Button>
          {profile.moreMenu ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button ref={menuTrigger} size="icon" className="btn-sm" aria-label={`More actions for ${profile.name}`}><Ellipsis size={16} aria-hidden="true" /></Button></DropdownMenuTrigger>
              <DropdownMenuContent aria-label={`More actions for ${profile.name}`}>
                {profile.moreMenu.filter(menu => menu.id === 'copy' ? info?.features.copy : info?.features.profileEdits).map(menu => (
                  <DropdownMenuItem key={menu.id} label={menu.label} detail={menu.detail} disabledReason={menu.disabledReason}
                    onSelect={() => menu.id === 'copy' ? navigate(`/profiles/${encodeURIComponent(profile.name)}/copy`) : onMenu(menu, menuTrigger.current)} />
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>
      <div className="profile-card-notice" data-status={feedback.status}>
        <span className="profile-card-notice-text" role={feedback.status === 'error' ? 'alert' : 'status'}>
          {NoticeIcon ? <NoticeIcon size={16} aria-hidden="true" /> : working ? <Spinner /> : null}
          <span className="truncate" title={feedback.text}>{feedback.text}</span>
        </span>
        {showDetails ? <Button variant="ghost-link" className="btn-sm" aria-expanded={Boolean(inspectorId)} aria-controls={inspectorId}
          onClick={event => onInspect(event, detailsTrigger.current)}>See details</Button> : null}
      </div>
      {hints.desktop ? <p id={desktopSignInHintId} className="sr-only">{claudeDesktopSignInHint}</p> : null}
      {hints.handoff ? <p id={handoffHintId} className="sr-only">{claudeHandoffHint}</p> : null}
      <div className="profile-surfaces">
        {surfaceRows(profile).map(({ label, info: surface }) => {
          const state = surfaceStates[surface.state];
          const desktop = label === 'Desktop';
          const SurfaceIcon = desktop ? Monitor : Terminal;
          const actions = info?.features.clientControls ? profile.clientActions
            .filter(action => desktopActions.has(action.id) === desktop)
            .sort((a, b) => Number(primaryClientActions.has(a.id)) - Number(primaryClientActions.has(b.id))) : [];
          return <div key={label} className="profile-surface" role="group" aria-label={label}>
            <span className="profile-surface-name"><SurfaceIcon size={16} aria-hidden="true" />{label}</span>
            <span className="profile-status-item"><SurfaceDot state={state} />{surfaceLabels[state]}</span>
            {actions.length ? <div className="profile-client-actions">{actions.map(action => {
              const ActionIcon = actionIcons[action.id] ?? SurfaceIcon;
              const busy = busyAction === action.id;
              const actionLabel = action.label.replace(/…$/, '');
              return <Tooltip key={action.id} content={checkingAccount ? `${actionLabel} · Checking sign-in…` : actionLabel}>
                <Button ref={retainActionFocus} size="icon" className="btn-sm"
                  data-secondary={action.id === 'close-terminal' || action.id === 'close-desktop' || undefined}
                  onClick={() => onClient(action, title.current)} disabled={Boolean(busyAction)} busy={busy}
                  aria-disabled={checkingAccount || undefined}
                  data-account-checking={checkingAccount || undefined}
                  aria-describedby={hints.handoff && action.id === 'open-terminal' ? handoffHintId
                    : hints.desktop && action.id === 'open-desktop' ? desktopSignInHintId : undefined}
                  aria-label={`${actionLabel} for ${profile.name}`}>{busy ? <Spinner /> : <ActionIcon size={16} aria-hidden="true" />}</Button>
              </Tooltip>;
            })}</div> : null}
            <p className="profile-status-account">
              {!desktop && profile.account && sharedAccount ? <span>Shared · </span> : null}
              <span className="truncate" title={desktop ? desktopAccount : accountText}>{desktop ? desktopAccount : accountText}</span>
              {!desktop && lastChecked ? <span className="profile-account-freshness">Last checked</span> : null}
            </p>
          </div>;
        })}
      </div>
    </article>
  );
}

function ProfileInspector({ id, profile, notice, revealing, closeButton, onClose, onReveal }:
  { id: string; profile: ProfileCard; notice?: CardNotice; revealing: boolean; closeButton: RefObject<HTMLButtonElement | null>;
    onClose: () => void; onReveal: () => void }) {
  const info = useInfo();
  const client = profile.client ?? 'codex';
  const hints = showClaudeHints(profile, info?.features.clientControls);
  const native = client !== 'codex';
  const inspectTarget = { name: profile.name, client };
  return <aside id={id} className="profile-inspector" aria-labelledby={`${id}-title`}>
    <header className="profile-inspector-header">
      <div><h2 id={`${id}-title`} className="text-heading wrap-anywhere">{profile.name}</h2><p className="meta">{clientLabels[client]}</p></div>
      <Button ref={closeButton} size="icon" className="btn-sm" aria-label="Close profile details" onClick={onClose}><X size={16} aria-hidden="true" /></Button>
    </header>
    <div className="profile-inspector-body">
      {notice?.blocker ? <section className="profile-inspector-section wrap-anywhere" aria-labelledby={`${id}-blocker`}>
        <h3 id={`${id}-blocker`} className="text-ui font-semibold">Desktop blocker</h3>
        <p className="alert-error">{notice.text}</p>
        {notice.blocker.processes.length ? <ul className="list-disc ps-5">
          {notice.blocker.processes.map(process => <li key={process}>{process}</li>)}
        </ul> : null}
        <p>{notice.blocker.guidance}</p>
        {notice.blocker.command ? <code className="profile-inspector-path select-all">{notice.blocker.command}</code> : null}
      </section> : null}
      <section className="profile-inspector-section" aria-labelledby="inspector-status">
        <h3 id="inspector-status" className="text-ui font-semibold">Status and accounts</h3>
        {notice && !notice.blocker ? <p className={notice.status === 'neutral' ? 'notice' : `alert-${notice.status}`}>{notice.text}</p> : null}
        {profile.state !== 'ready' ? <WarningAlert title={warningTitle(profile)}>{profile.reason}</WarningAlert> : null}
        <dl className="profile-inspector-facts">
          {surfaceRows(profile).map(({ name, info: surface }) => {
            const state = surfaceStates[surface.state];
            return [
              <dt key={`${name}-label`} className="muted"><SurfaceDot state={state} /> {name}</dt>,
              <dd key={`${name}-text`}>{surface.text}</dd>,
            ];
          })}
          <dt className="muted">Sign-in</dt>
          <dd>{profile.account ? <>
            <span className="muted">{accountScope(profile)}</span>{' · '}{profile.account.label}{profile.account.lastChecked ? ' (last checked)' : ''}
          </> : profile.signIn}</dd>
        </dl>
      </section>
      {profile.folder ? <section className="profile-inspector-section" aria-labelledby="inspector-folder">
        <h3 id="inspector-folder" className="text-ui font-semibold">Folder</h3>
        <code className="profile-inspector-path select-all">{profile.folder}</code>
        {info?.features.clientControls ? <div><Button className="btn-sm" aria-label={`Show ${profile.name} folder in Finder`} aria-busy={revealing || undefined}
          onClick={() => { if (!revealing) onReveal(); }}>{revealing ? <Spinner /> : <FolderOpen size={16} aria-hidden="true" />}Show in Finder</Button></div> : null}
      </section> : null}
      <section className="profile-inspector-section" aria-labelledby="inspector-setup">
        <h3 id="inspector-setup" className="text-ui font-semibold">Setup</h3>
        <p className="text-ui">{profile.summary}</p>
        <p className="meta">{profile.binding}</p>
        {profile.repositories?.length ? <ul className="flex flex-col gap-1">
          {profile.repositories.map(repository => <li key={repository}><code className="text-ui wrap-anywhere">{repository}</code></li>)}
        </ul> : null}
      </section>
      <section className="profile-inspector-section" aria-labelledby="inspector-signin">
        <h3 id="inspector-signin" className="text-ui font-semibold">How sign-in works</h3>
        {!native && !profile.isDefault && profile.state === 'ready' ? <p className="text-ui">{sharedSignIn}</p> : null}
        {native ? <>
          <p className="text-ui">{separateSignIns}</p>
          <p className="hint">See the Desktop account in the app’s account menu.</p>
        </> : null}
        {hints.desktop ? <p className="hint">{claudeDesktopSignInHint}</p> : null}
        {hints.handoff ? <p className="hint">{claudeHandoffHint}</p> : null}
      </section>
      <section className="profile-inspector-section" aria-labelledby="inspector-inspect">
        <h3 id="inspector-inspect" className="text-ui font-semibold">Inspect</h3>
        <div className="profile-inspect-actions">
          <Link to={setupInspectHref(inspectTarget)}>Inspect setup</Link>
          <Link to={`/sessions/native?${new URLSearchParams({ profile: profile.name, client })}`}>Inspect sessions</Link>
          <Link to={`/compare/setups?${new URLSearchParams(setupParams(inspectTarget))}`}>Compare with…</Link>
        </div>
      </section>
    </div>
  </aside>;
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

function CreateDialog({ open, onClose, returnFocus, sources, onCreated }: { open: boolean; onClose: () => void;
  returnFocus: RefObject<HTMLButtonElement | null>; sources: Record<ProfileClient, string[]>; onCreated: (text: string) => void }) {
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
        <DialogContent title="Create a profile" onCloseAutoFocus={event => {
          if (returnFocus.current?.isConnected) { event.preventDefault(); returnFocus.current.focus(); }
        }}>
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
  add: { title: 'Add existing profile folder', field: 'Profile name', second: 'Codex folder', action: 'Add folder', path: '/api/profiles/new', note: 'Xenoflux registers the folder as a profile. It doesn’t move or change its files.' },
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
