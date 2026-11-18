import { useCallback, useEffect, useEffectEvent, useId, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { CircleCheck, CircleX, Ellipsis, FolderOpen, LogIn, Monitor, PanelRight, Play, ScanLine, Square, Terminal, TriangleAlert } from 'lucide-react';
import { ApiError, apiGet, apiPost } from '@/api/client';
import type { ClientAction, ClientActionResult, ClientInfo, ClientState, MenuAction, NativeSigninAttempt, ProfileCard, ProfileClient, ProfilesView, StatusKind } from '@/api/types';
import { setupInspectHref, setupParams } from '@/components/setup-inventory';
import { Loading, LoadError, Page, PageTitle, useInfo } from '@/components/layout';
import { ErrorPanel, SimulatedNote, WarningAlert } from '@/components/notices';
import { StatusBadge } from '@/components/badges';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
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
};

type SurfaceState = 'open' | 'closed' | 'unknown';
const surfaceStates: Record<ClientState, SurfaceState> = { running: 'open', 'not-running': 'closed', unknown: 'unknown', unavailable: 'unknown' };
const surfaceLabels: Record<SurfaceState, string> = { open: 'Open', closed: 'Closed', unknown: 'Unknown' };

type CardActivity = { kind: 'idle' } | { kind: 'checking-account' } | { kind: 'signing-in' } | { kind: 'action'; id: string };
type CardNotice = { status: StatusKind; text: string };
type ClientIcons = Partial<Record<ProfileClient, string | null>>;
const clientInitials: Record<ProfileClient, string> = { codex: 'Cx', 'claude-code': 'Cl', copilot: 'Gh' };
const cardKey = (profile: ProfileCard) => `${profile.client ?? 'codex'}:${profile.name}`;
const desktopActions = new Set(['open-desktop', 'focus-desktop', 'close-desktop']);
const actionIcons: Partial<Record<string, typeof Play>> = {
  'open-terminal': Play, 'open-desktop': Play, 'show-terminal': Terminal, 'focus-desktop': Monitor,
  'close-terminal': Square, 'close-desktop': Square, signin: LogIn, check: ScanLine,
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
  const [cardNotices, setCardNotices] = useState<Partial<Record<string, CardNotice>>>({});
  const pendingClients = useRef(new Set<string>());
  const [busyClients, setBusyClients] = useState<Record<string, string>>({});
  const checkedOnVisit = useRef(new Set<string>());
  const [checkingAccount, setCheckingAccount] = useState<string | null>(null);
  const [inspected, setInspected] = useState<string | null>(null);
  const inspectTrigger = useRef<HTMLButtonElement | null>(null);
  const [revealing, setRevealing] = useState<string | null>(null);
  const [icons, setIcons] = useState<ClientIcons>({});
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
    let current = true;
    apiGet<ClientIcons>('/api/clients/icons').then(value => { if (current) setIcons(value); }, () => undefined);
    return () => { current = false; };
  }, []);

  useEffect(() => {
    if (inspected && data && !data.profiles.some(profile => cardKey(profile) === inspected)) setInspected(null);
  }, [inspected, data]);

  useEffect(() => {
    if (params.get('create')) setDialog({ kind: 'create' });
    else if (params.get('add')) setDialog({ kind: 'add' });
  }, [params]);
  const close = () => { setDialog(null); if (params.size) setParams({}, { replace: true }); };
  const reportCard = (profile: ProfileCard, notice?: CardNotice) =>
    setCardNotices(current => ({ ...current, [cardKey(profile)]: notice }));

  async function runClientAction(profile: ProfileCard, action: ClientAction, heading: HTMLHeadingElement | null) {
    if (pendingClients.current.has(profile.name)) return;
    if (action.conflict) { setDialog({ kind: 'conflict', profile: profile.name, action }); return; }
    reportCard(profile);
    if (action.id === 'signin' && profile.client && profile.client !== 'codex') { setSignIn({ profile, heading }); return; }
    if (action.id === 'check') checkedOnVisit.current.add(profile.name);
    pendingClients.current.add(profile.name);
    setBusyClients(value => ({ ...value, [profile.name]: action.id }));
    try {
      const result = await apiPost<ClientActionResult>(`/api/profiles/${encodeURIComponent(profile.name)}/clients`, {
        action: action.id,
        ...(action.appKey ? { appKey: action.appKey } : {}),
        ...(action.runId ? { runId: action.runId } : {}),
      });
      reportCard(profile, { status: result.status, text: result.message });
      view.reload();
    } catch (error) { reportCard(profile, { status: 'error', text: error instanceof Error ? error.message : 'Client action failed.' }); }
    finally {
      pendingClients.current.delete(profile.name);
      setBusyClients(value => { const next = { ...value }; delete next[profile.name]; return next; });
      if ((action.id === 'check' || action.id === 'close-terminal') && document.activeElement === document.body) heading?.focus();
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

  const activityFor = (name: string): CardActivity => {
    if (signIn?.profile.name === name) return { kind: 'signing-in' };
    if (checkingAccount === name) return { kind: 'checking-account' };
    return busyClients[name] ? { kind: 'action', id: busyClients[name] } : { kind: 'idle' };
  };
  const inspect = (name: string, trigger: HTMLButtonElement | null) => { inspectTrigger.current = trigger; setInspected(name); };
  const profileCards = view.data?.profiles ?? [];
  const inspectedProfile = inspected ? profileCards.find(profile => cardKey(profile) === inspected) : undefined;
  const names = profileCards.filter(p => !p.client || p.client === 'codex').map(p => p.name);
  return (
    <Page current="profiles" title="Profiles">
      <PageTitle title="Profiles"
        subtitle="Profiles grouped by client. Open a profile’s details for sign-in rules and folder information."
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
              <div className="profile-grid">{profiles.map(profile => (
                <ProfileCardView key={profile.name} profile={profile} icon={icons[profile.client ?? 'codex'] ?? null} activity={activityFor(profile.name)}
                  notice={cardNotices[cardKey(profile)]} revealing={revealing === cardKey(profile)} onReveal={() => void revealFolder(profile)}
                  onInspect={trigger => inspect(cardKey(profile), trigger)}
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

      <Sheet open={Boolean(inspectedProfile)} onOpenChange={open => { if (!open) setInspected(null); }}>
        {inspectedProfile ? <SheetContent className="profile-inspector" aria-describedby={undefined}
          onCloseAutoFocus={event => { event.preventDefault(); if (inspectTrigger.current?.isConnected) inspectTrigger.current.focus(); }}>
          <ProfileInspector profile={inspectedProfile} notice={cardNotices[cardKey(inspectedProfile)]}
            revealing={revealing === cardKey(inspectedProfile)} onReveal={() => void revealFolder(inspectedProfile)} />
        </SheetContent> : null}
      </Sheet>

      {signIn ? <SigninDialog profile={signIn.profile} returnFocus={signIn.heading} onClose={() => setSignIn(null)} onRefresh={view.reload}
        onResult={notice => reportCard(signIn.profile, notice)} /> : null}

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

function SigninDialog({ profile, returnFocus, onClose, onRefresh, onResult }:
  { profile: ProfileCard; returnFocus: HTMLHeadingElement | null; onClose: () => void; onRefresh: () => void;
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

  function receive(next: NativeSigninAttempt) {
    setAttempt(next); setError(null);
    if (!activeSigninStates.has(next.state)) {
      if (next.state === 'completed') onResult({ status: 'success', text: signinLabels.completed });
      else if (next.state !== 'cancelled') onResult({ status: next.state === 'uncertain' ? 'warning' : 'error', text: next.message });
      onRefresh();
    }
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
    onResult();
    try { receive(await apiPost<NativeSigninAttempt>(`/api/profiles/${encodeURIComponent(profile.name)}/sign-in`)); }
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

function ProfileCardView({ profile, icon, activity, notice, revealing, onClient, onMenu, onInspect, onReveal }:
  { profile: ProfileCard; icon: string | null; activity: CardActivity; notice?: CardNotice; revealing: boolean; onReveal: () => void;
    onClient: (action: ClientAction, heading: HTMLHeadingElement | null) => void; onMenu: (menu: MenuAction, trigger: HTMLButtonElement | null) => void;
    onInspect: (trigger: HTMLButtonElement | null) => void }) {
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
  const busyAction = activity.kind === 'action' ? activity.id : undefined;
  const working = activity.kind === 'checking-account' ? 'Checking sign-in…'
    : activity.kind === 'signing-in' ? 'Signing in…'
    : busyAction === 'signin' ? 'Opening Terminal…'
    : busyAction === 'check' ? 'Checking sign-in…'
    : busyAction ? clientBusyLabels[busyAction] ?? 'Working…'
    : revealing ? 'Showing in Finder…' : null;
  const problem: CardNotice | undefined = profile.state === 'ready' ? undefined
    : { status: profile.state === 'unbound' ? 'warning' : 'error', text: warningTitle(profile) };
  const feedback = notice?.status === 'error' || notice?.status === 'warning' ? notice
    : problem ?? (working ? { status: 'neutral' as const, text: working } : notice);
  const showDetails = feedback?.status === 'warning' || feedback?.status === 'error';
  const NoticeIcon = feedback?.status === 'error' ? CircleX : feedback?.status === 'warning' ? TriangleAlert
    : feedback?.status === 'success' ? CircleCheck : null;
  const accountText = profile.account?.label ?? profile.signIn;
  return (
    <article className="profile-card" aria-labelledby={titleId}>
      <div className="profile-card-header">
        {icon ? <img className="profile-app-icon" src={icon} alt="" width={32} height={32} />
          : <span className="profile-app-icon" aria-hidden="true">{clientInitials[client]}</span>}
        <div className="profile-card-title">
          <h3 id={titleId} ref={title} tabIndex={-1} title={profile.name} className="text-body font-semibold truncate">{profile.name}</h3>
          <p className="meta truncate">{clientLabel} · {profile.binding}</p>
        </div>
        <div className="profile-card-tools">
          {profile.folder && info?.features.clientControls ? <Tooltip content={<>Show in Finder<br />{profile.folder}</>}>
            <Button size="icon" className="btn-sm" aria-label={`Show ${profile.name} folder in Finder`} aria-busy={revealing || undefined}
              onClick={() => { if (!revealing) onReveal(); }}><FolderOpen size={16} aria-hidden="true" /></Button>
          </Tooltip> : null}
          <Button ref={detailsTrigger} size="icon" className="btn-sm" aria-label={`Details for ${profile.name}`} onClick={() => onInspect(detailsTrigger.current)}>
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
      {feedback ? <div className="profile-card-notice" data-status={feedback.status}>
        <span className="profile-card-notice-text" role={feedback.status === 'error' ? 'alert' : 'status'}>
          {NoticeIcon ? <NoticeIcon size={16} aria-hidden="true" /> : working ? <Spinner /> : null}
          {feedback.text}
        </span>
        {showDetails ? <Button variant="ghost-link" className="btn-sm" onClick={event => onInspect(event.currentTarget)}>See details</Button> : null}
      </div> : null}
      {hints.desktop ? <p id={desktopSignInHintId} className="sr-only">{claudeDesktopSignInHint}</p> : null}
      {hints.handoff ? <p id={handoffHintId} className="sr-only">{claudeHandoffHint}</p> : null}
      <div className="profile-surfaces">
        {surfaceRows(profile).map(({ label, info: surface }) => {
          const state = surfaceStates[surface.state];
          const desktop = label === 'Desktop';
          const SurfaceIcon = desktop ? Monitor : Terminal;
          const actions = info?.features.clientControls ? profile.clientActions.filter(action => desktopActions.has(action.id) === desktop) : [];
          return <div key={label} className="profile-surface" role="group" aria-label={label}>
            <span className="profile-surface-name"><SurfaceIcon size={16} aria-hidden="true" />{label}</span>
            <div className="profile-surface-facts">
              <span className="profile-status-item"><SurfaceDot state={state} />{surfaceLabels[state]}</span>
              {!desktop ? <span className="profile-status-account">
                {profile.account && client === 'codex' && !profile.isDefault ? 'Shared account · ' : null}<span>{accountText}</span>
              </span> : client !== 'codex' && profile.state === 'ready' ? <span className="profile-status-account">Account in Desktop</span> : null}
            </div>
            {actions.length ? <div className="profile-client-actions">{actions.map(action => {
              const ActionIcon = actionIcons[action.id] ?? SurfaceIcon;
              const busy = busyAction === action.id;
              const actionLabel = action.label.replace(/…$/, '');
              return <Tooltip key={action.id === 'check' ? 'signin' : action.id} content={actionLabel}>
                <Button ref={retainActionFocus} size="icon" className="btn-sm"
                  data-secondary={action.id === 'close-terminal' || action.id === 'close-desktop' || undefined}
                  onClick={() => onClient(action, title.current)} disabled={Boolean(busyAction)} busy={busy}
                  aria-disabled={activity.kind === 'checking-account' || undefined}
                  aria-describedby={hints.handoff && action.id === 'open-terminal' ? handoffHintId
                    : hints.desktop && action.id === 'open-desktop' ? desktopSignInHintId : undefined}
                  aria-label={`${actionLabel} for ${profile.name}`}>{busy ? <Spinner /> : <ActionIcon size={16} aria-hidden="true" />}</Button>
              </Tooltip>;
            })}</div> : null}
          </div>;
        })}
      </div>
    </article>
  );
}

function ProfileInspector({ profile, notice, revealing, onReveal }: { profile: ProfileCard; notice?: CardNotice; revealing: boolean; onReveal: () => void }) {
  const info = useInfo();
  const client = profile.client ?? 'codex';
  const hints = showClaudeHints(profile, info?.features.clientControls);
  const native = client !== 'codex';
  const inspectTarget = { name: profile.name, client };
  return <>
    <SheetHeader>
      <SheetTitle>{profile.name}</SheetTitle>
      <SheetDescription>{clientLabels[client]}</SheetDescription>
    </SheetHeader>
    <div className="profile-inspector-body">
      <section className="profile-inspector-section" aria-labelledby="inspector-status">
        <h3 id="inspector-status" className="text-ui font-semibold">Status</h3>
        {notice?.status === 'error' || notice?.status === 'warning' ? <p className={`alert-${notice.status}`}>{notice.text}</p> : null}
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
  </>;
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
