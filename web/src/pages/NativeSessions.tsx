import { useId, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { apiGet, apiPost } from '@/api/client';
import type { ProfilesView, Side } from '@/api/types';
import { LoadError, Loading, Page, PageTitle } from '@/components/layout';
import { ErrorPanel } from '@/components/notices';
import { SideText } from '@/components/profile';
import { Button } from '@/components/ui/button';
import { useResource } from '@/lib/useResource';

type Client = 'codex' | 'claude-code' | 'copilot';
type Profile = { name: string; client: Client };
type Selection = { client: Client; token: string };
type SessionList = {
  client: Client; profileId: string; rootMode: 'implicit' | 'explicit'; surface?: string; executionLocation: string;
  sessions: { token: string | null; id?: string; sessionId?: string; title: string | null; cwd?: string; workspace?: string; modifiedAt: number | string; surface?: string }[];
};

const labels = { codex: 'Codex', 'claude-code': 'Claude Code', copilot: 'Copilot CLI' };
const key = ({ name, client }: Profile) => `${client}:${name}`;

export function NativeSessions() {
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

  return <Page current="compare" title="Choose native sessions">
    <PageTitle breadcrumb={[{ label: 'Compare', to: '/' }, { label: 'Use existing sessions', to: '/compare/sessions' }, { label: 'Choose by profile' }]}
      title="Choose native sessions" subtitle="List recent sessions from the profile you select. Comparing reads stored history without resuming a session or starting a task." />
    {profiles.error ? <LoadError error={profiles.error} onRetry={profiles.reload} /> : null}
    {profiles.loading && !profiles.data ? <Loading label="Reading profiles…" /> : null}
    {profiles.data && !options.length ? <p>No native profiles are available. <Link to="/profiles">Open Profiles</Link></p> : null}
    {options.length ? <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(350px, 100%), 1fr))' }}>
      {(['a', 'b'] as const).map(side => <SessionSide key={side} side={side} options={options} busy={busy}
        selection={selection[side]} onChange={value => { setError(''); setSelection(current => ({ ...current, [side]: value })); }} />)}
    </div> : null}
    {error ? <ErrorPanel title="Couldn’t compare sessions">{error}</ErrorPanel> : null}
    <div className="flex items-center gap-4 flex-wrap">
      <Button variant="primary" disabled={!selection.a || !selection.b} busy={busy} busyLabel="Reading selected sessions…" onClick={() => void compare()}>Compare selected sessions</Button>
      <p className="hint" role="status">{[selection.a, selection.b].filter(Boolean).length} of 2 chosen</p>
    </div>
  </Page>;
}

function SessionSide({ side, options, selection, busy, onChange }: {
  side: Side; options: Profile[]; selection?: Selection; busy: boolean; onChange: (value?: Selection) => void;
}) {
  const id = useId();
  const [profileKey, setProfileKey] = useState('');
  const [list, setList] = useState<SessionList>();
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const profile = options.find(item => key(item) === profileKey);

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
    <h2 id={`${id}-title`} className="text-heading"><SideText side={side}>{side === 'a' ? 'Left' : 'Right'} session</SideText></h2>
    <div>
      <label className="field-label" htmlFor={id}>{side === 'a' ? 'Left' : 'Right'} profile</label>
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
      {list.sessions.map((row, index) => <label key={row.token ?? row.id ?? row.sessionId ?? index} className="flex items-start gap-2 py-2 border-b border-border">
        <input type="radio" name={id} disabled={busy || !row.token} checked={!!row.token && selection?.token === row.token}
          onChange={() => { if (row.token) onChange({ client: list.client, token: row.token }); }} />
        <span className="min-w-0 wrap-anywhere">
          <span className="text-ui font-medium block">{row.title || 'Untitled session'}</span>
          <span className="hint block">{row.cwd ?? row.workspace ?? 'Folder unknown'}</span>
          <span className="hint block">{row.surface ? row.surface.toUpperCase() + ' · ' : ''}{new Date(row.modifiedAt).toLocaleString()}{row.token ? '' : ' · Unavailable for import'}</span>
        </span>
      </label>)}
    </fieldset> : null}
  </section>;
}
