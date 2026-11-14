import { useId, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { apiGet, apiPost } from '@/api/client';
import type { ProfilesView, SessionInspection, Side } from '@/api/types';
import { LoadError, Loading, Page, PageTitle } from '@/components/layout';
import { ErrorPanel, InfoNotice } from '@/components/notices';
import { SideText } from '@/components/profile';
import { Button } from '@/components/ui/button';
import { useResource } from '@/lib/useResource';
import { InspectSessionButton } from '@/components/inspect-session-button';

type Client = 'codex' | 'claude-code' | 'copilot';
type Profile = { name: string; client: Client };
type Selection = { client: Client; token: string };
type SessionList = {
  client: Client; profileId: string; rootMode: 'implicit' | 'explicit'; surface?: string; executionLocation: string;
  sessions: { token: string | null; id?: string; sessionId?: string; title: string | null; cwd?: string; workspace?: string; modifiedAt: number | string; surface?: string }[];
};

const labels = { codex: 'Codex', 'claude-code': 'Claude Code', copilot: 'Copilot CLI' };
const key = ({ name, client }: Profile) => `${client}:${name}`;

export function NativeSessions({ inspect = false }: { inspect?: boolean }) {
  const [params] = useSearchParams();
  const compareWith = inspect ? params.get('compareWith') ?? undefined : undefined;
  const base = useResource(() => compareWith ? apiGet<SessionInspection>(`/api/sessions/inspect/${encodeURIComponent(compareWith)}`) : Promise.resolve(null), compareWith ?? 'no-inspection');
  const profiles = useResource(() => apiGet<ProfilesView>('/api/profiles'), 'native-session-profiles');
  const navigate = useNavigate();
  const [selection, setSelection] = useState<{ a?: Selection; b?: Selection }>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const options: Profile[] = (['codex', 'claude-code', 'copilot'] as const).flatMap(client => {
    const names = new Set(profiles.data?.copySources?.[client]);
    for (const profile of profiles.data?.profiles ?? []) if ((profile.client ?? 'codex') === client) names.add(profile.name);
    return [...names].map(name => ({ name, client }));
  });

  async function compare() {
    if (!selection.a || !selection.b || busy) return;
    setBusy(true); setError('');
    try {
      const result = await apiPost<{ ref: string }>('/api/compare/sessions/import', { left: selection.a, right: selection.b });
      navigate(`/reports/${encodeURIComponent(result.ref)}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  }

  return <Page current={inspect ? 'sessions' : 'compare'} title={inspect ? 'Choose a session' : 'Choose native sessions'}>
    <PageTitle breadcrumb={inspect ? [{ label: 'Browse sessions', to: '/sessions' }, { label: 'Choose by profile' }] : [{ label: 'Compare', to: '/' }, { label: 'Use existing sessions', to: '/compare/sessions' }, { label: 'Choose by profile' }]}
      title={inspect ? 'Choose a session' : 'Choose native sessions'} subtitle="List recent sessions from the profile you select. History inspection does not resume a session or submit a model task." />
    {compareWith && base.data ? <InfoNotice title="Left session is retained">
      <p>{base.data.profile} · {base.data.title} · {base.data.mode}</p>
      <p>Choose the right session below. The left evidence stays exactly as inspected; matching titles do not establish the same task.</p>
    </InfoNotice> : null}
    {base.error ? <LoadError error={base.error} onRetry={base.reload} /> : null}
    {compareWith && base.loading && !base.data ? <Loading label="Reading retained left session…" /> : null}
    {inspect ? <p className="hint">Codex exposes bounded native history. Claude Code and Copilot imports retain public conversation text with partial coverage; tools, usage and original execution settings may be unavailable. Copilot listing uses its native CLI and existing sign-in; a managed profile needs a bound repository.</p> : null}
    {profiles.error ? <LoadError error={profiles.error} onRetry={profiles.reload} /> : null}
    {profiles.loading && !profiles.data ? <Loading label="Reading profiles…" /> : null}
    {profiles.data && !options.length ? <p>No native profiles are available. <Link to="/profiles">Open Profiles</Link></p> : null}
    {options.length ? <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(350px, 100%), 1fr))' }}>
      {(inspect ? ['a'] as const : ['a', 'b'] as const).map(side => <SessionSide key={side} side={side} options={options} busy={busy} inspect={inspect}
        compareWith={compareWith} comparisonUnavailable={Boolean(compareWith && !base.data)}
        initialProfileKey={params.get('profile') ? `${params.get('client') ?? 'codex'}:${params.get('profile')}` : ''}
        selection={selection[side]} onChange={value => { setError(''); setSelection(current => ({ ...current, [side]: value })); }} />)}
    </div> : null}
    {error ? <ErrorPanel title="Couldn’t compare sessions">{error}</ErrorPanel> : null}
    {!inspect ? <div className="flex items-center gap-4 flex-wrap">
      <Button variant="primary" disabled={!selection.a || !selection.b} busy={busy} busyLabel="Reading selected sessions…" onClick={() => void compare()}>Compare selected sessions</Button>
      <p className="hint" role="status">{[selection.a, selection.b].filter(Boolean).length} of 2 chosen</p>
    </div> : null}
  </Page>;
}

function SessionSide({ side, options, selection, busy, onChange, inspect, initialProfileKey, compareWith, comparisonUnavailable }: {
  side: Side; options: Profile[]; selection?: Selection; busy: boolean; onChange: (value?: Selection) => void; inspect: boolean; initialProfileKey: string;
  compareWith?: string; comparisonUnavailable: boolean;
}) {
  const id = useId();
  const [profileKey, setProfileKey] = useState(initialProfileKey);
  const [list, setList] = useState<SessionList>();
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const profile = options.find(item => key(item) === profileKey);
  const RowText = inspect ? 'div' : 'label';

  async function load() {
    if (!profile || reading) return;
    const owner = ++generation.current;
    setReading(true); setError(''); setList(undefined); onChange();
    try {
      const result = await apiGet<SessionList>(`/api/sessions/${profile.client}`, { profile: profile.name, limit: '30' });
      if (generation.current === owner) setList(result);
    } catch (reason) {
      if (generation.current === owner) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (generation.current === owner) setReading(false);
    }
  }

  return <section className="panel min-w-0 flex flex-col gap-3" aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`} className="text-heading">{inspect ? 'Recorded sessions' : <SideText side={side}>{side === 'a' ? 'Left' : 'Right'} session</SideText>}</h2>
    <div>
      <label className="field-label" htmlFor={id}>{inspect ? 'Profile' : `${side === 'a' ? 'Left' : 'Right'} profile`}</label>
      <select id={id} className="input" value={profileKey} disabled={busy} onChange={event => {
        generation.current++;
        setProfileKey(event.target.value); setList(undefined); setError(''); setReading(false); onChange();
      }}>
        <option value="">Choose a profile</option>
        {options.map(item => <option key={key(item)} value={key(item)}>{item.name} · {labels[item.client]} · {item.name === 'Default' ? 'stock root' : 'managed root'}</option>)}
      </select>
    </div>
    <div><Button disabled={!profile || busy} busy={reading} busyLabel="Listing…" onClick={() => void load()}>List recent sessions</Button></div>
    {error ? <ErrorPanel title="Couldn’t list sessions">{error}</ErrorPanel> : null}
    {list ? <fieldset className="flex flex-col gap-3 min-w-0">
      <legend className="field-label">{profile?.name} · {labels[list.client]} · {list.surface ? list.surface.toUpperCase() + ' · ' : ''}{list.rootMode === 'implicit' ? 'stock root' : 'managed root'} · {list.executionLocation ?? 'local'}</legend>
      {!list.sessions.length ? <p className="hint">No recent sessions were found.</p> : null}
      {list.sessions.map((row, index) => <div key={row.token ?? row.id ?? row.sessionId ?? index} className="flex flex-wrap items-start gap-2 py-2 border-b border-border">
        <RowText className="flex items-start gap-2 min-w-0">
        {!inspect ? <input type="radio" name={id} aria-label={row.title || 'Untitled session'} disabled={busy || !row.token} checked={!!row.token && selection?.token === row.token}
          onChange={() => { if (row.token) onChange({ client: list.client, token: row.token }); }} /> : null}
        <span className="min-w-0 wrap-anywhere">
          <span className="text-ui font-medium block">{row.title || 'Untitled session'}</span>
          <span className="hint block">{row.cwd ?? row.workspace ?? 'Folder unknown'}</span>
          <span className="hint block">{row.surface ? row.surface.toUpperCase() + ' · ' : ''}{new Date(row.modifiedAt).toLocaleString()}{row.token ? '' : ' · Unavailable for import'}</span>
        </span>
        </RowText>
        {inspect && row.token ? <InspectSessionButton selection={{ client: list.client, token: row.token }} compareWith={compareWith} disabled={comparisonUnavailable}
          label={`${compareWith ? 'Compare with' : 'Inspect'} ${row.title || 'Untitled session'}`} /> : null}
      </div>)}
    </fieldset> : null}
  </section>;
}
