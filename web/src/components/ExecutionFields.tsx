import { useEffect, useId, useRef, useState } from 'react';
import { apiGet, apiPost } from '@/api/client';
import type { ExecutionSelection, ModelCatalogSnapshot } from '@/api/types';
import { Button } from '@/components/ui/button';

type CatalogState = { context: string; snapshot: ModelCatalogSnapshot | null; busy: boolean; message: string };

export function ExecutionFields({ profile, workspace, value, onChange, disabled }: {
  profile: string; workspace: string; value: ExecutionSelection;
  onChange: (value: ExecutionSelection) => void; disabled?: boolean;
}) {
  const id = useId();
  const context = JSON.stringify([profile, workspace]);
  const currentContext = useRef(context);
  currentContext.current = context;
  const generation = useRef(0);
  const activeRefresh = useRef<string | null>(null);
  const change = useRef(onChange);
  change.current = onChange;
  const previousContext = useRef(context);
  const [state, setState] = useState<CatalogState>({ context, snapshot: null, busy: false, message: '' });
  const [now, setNow] = useState(Date.now());
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    const owner = ++generation.current;
    setCancelling(false);
    if (previousContext.current !== context) change.current({});
    previousContext.current = context;
    setState({ context, snapshot: null, busy: false, message: profile ? 'Checking saved model catalog…' : 'Choose a profile to discover its models.' });
    if (profile) {
      apiGet<ModelCatalogSnapshot>('/api/catalog', { profile, workspace }).then(snapshot => {
        if (currentContext.current === context && generation.current === owner)
          setState({ context, snapshot, busy: false, message: '' });
      }).catch(error => {
        if (currentContext.current === context && generation.current === owner)
          setState({ context, snapshot: null, busy: false, message: String(error.message) });
      });
    }
    return () => {
      generation.current++;
      if (activeRefresh.current) {
        void apiPost('/api/catalog/cancel', { requestId: activeRefresh.current }).catch(() => {});
        activeRefresh.current = null;
      }
    };
  }, [context, profile, workspace]);

  const snapshot = state.context === context ? state.snapshot : null;
  useEffect(() => {
    setNow(Date.now());
    if (!snapshot?.expiresAt) return;
    const remaining = Date.parse(snapshot.expiresAt) - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(remaining + 1, 2147483647));
    return () => clearTimeout(timer);
  }, [snapshot]);
  const expired = snapshot?.expiresAt ? Date.parse(snapshot.expiresAt) <= now : false;
  const ready = snapshot?.status === 'ready' && !expired;
  const models = ready ? snapshot.models.filter(model => !model.hidden) : [];
  const selected = value.model ? models.find(model => model.model === value.model) : models.find(model => model.isDefault);
  const efforts = selected?.supportedReasoningEfforts ?? [];
  const busy = state.context === context && state.busy;

  async function refresh() {
    if (activeRefresh.current || !profile) return;
    const owner = ++generation.current, requestId = crypto.randomUUID();
    activeRefresh.current = requestId;
    setState({ context, snapshot: null, busy: true, message: 'Refreshing models…' });
    try {
      const result = await apiPost<ModelCatalogSnapshot>('/api/catalog/refresh', { profile, workspace, requestId });
      if (currentContext.current === context && generation.current === owner)
        setState({ context, snapshot: result, busy: false, message: '' });
    } catch (error) {
      if (currentContext.current === context && generation.current === owner)
        setState({ context, snapshot: null, busy: false, message: error instanceof Error ? error.message : 'Model discovery failed. Try refreshing again.' });
    } finally {
      if (activeRefresh.current === requestId && generation.current === owner) activeRefresh.current = null;
    }
  }
  async function cancel() {
    const requestId = activeRefresh.current;
    if (!requestId || cancelling) return;
    const owner = ++generation.current;
    setCancelling(true);
    setState({ context, snapshot: null, busy: true, message: 'Stopping model refresh…' });
    try {
      const result = await apiPost<{ status: string }>('/api/catalog/cancel', { requestId });
      if (currentContext.current !== context || generation.current !== owner) return;
      const stopped = result.status === 'cancelled' || result.status === 'stopped';
      if (stopped) activeRefresh.current = null;
      setState({ context, snapshot: null, busy: !stopped, message: stopped
        ? 'Model refresh cancelled. Profile defaults remain available.'
        : 'Model refresh stop is unconfirmed. Retry cancellation; profile defaults remain available.' });
    } catch (error) {
      if (currentContext.current === context && generation.current === owner)
        setState({ context, snapshot: null, busy: true, message: `Could not confirm refresh cancellation. Retry cancellation. ${error instanceof Error ? error.message : ''}` });
    } finally {
      if (currentContext.current === context && generation.current === owner) setCancelling(false);
    }
  }
  const message = state.context !== context ? 'Checking saved model catalog…' : state.message || (expired
    ? 'Saved model catalog expired. Refresh to verify explicit choices.'
    : snapshot?.status === 'ready' ? models.length ? `${models.length} models available.` : 'The catalog returned no visible models.'
      : snapshot?.status === 'cancelled' ? 'Model refresh cancelled.' : snapshot ? 'Model catalog unavailable. Refresh models to try again.' : 'No saved model catalog. Refresh to discover models.');

  return <div className="flex flex-col gap-3 min-w-0">
    <div className="flex flex-wrap gap-3">
      <div className="flex-1 min-w-[140px]">
        <label className="field-label" htmlFor={`${id}-model`}>Model ID</label>
        <select id={`${id}-model`} className="input font-mono" value={value.model ?? ''} disabled={disabled}
          aria-describedby={`${id}-catalog`} onChange={event => onChange({ model: event.target.value || undefined })}>
          <option value="">Use profile default</option>
          {value.model && !models.some(model => model.model === value.model) ? <option value={value.model} disabled>{value.model} · unverified</option> : null}
          {models.map(model => <option key={model.id} value={model.model}>{model.displayName || model.model} · {model.model}</option>)}
        </select>
      </div>
      <div className="flex-1 min-w-[140px]">
        <label className="field-label" htmlFor={`${id}-effort`}>Reasoning effort</label>
        <select id={`${id}-effort`} className="input" value={value.reasoningEffort ?? ''} disabled={disabled}
          aria-describedby={`${id}-effort-hint`} onChange={event => onChange({ ...value, reasoningEffort: event.target.value || undefined })}>
          <option value="">Use profile default</option>
          {value.reasoningEffort && !efforts.some(effort => effort.reasoningEffort === value.reasoningEffort) ? <option value={value.reasoningEffort} disabled>{value.reasoningEffort} · unverified</option> : null}
          {efforts.map(effort => <option key={effort.reasoningEffort} value={effort.reasoningEffort}>{effort.reasoningEffort}{effort.description ? ` · ${effort.description}` : ''}</option>)}
        </select>
        <p id={`${id}-effort-hint`} className="hint mt-1">{selected?.supportedReasoningEfforts === null ? 'Effort support is unknown.' : selected && !efforts.length ? 'No explicit efforts advertised.' : !selected ? 'Refresh models to verify effort choices.' : 'Efforts advertised for this model.'}</p>
      </div>
    </div>
    <div className="flex flex-wrap gap-3 items-center">
      <Button onClick={() => void refresh()} disabled={disabled || !profile || busy} busy={busy} busyLabel="Refreshing models…">Refresh models</Button>
      {busy ? <Button onClick={() => void cancel()} disabled={cancelling}>Cancel model refresh</Button> : null}
    </div>
    <p id={`${id}-catalog`} className="hint break-words" role="status">{message}</p>
    {snapshot?.discoveredAt ? <p className="hint break-words">Source: {snapshot.source} · Retrieved {snapshot.discoveredAt} · Account identity: unknown.</p> : null}
    <p className="hint">Refresh initializes the native client and may use sign-in, write native state or run configured hooks. It sends no task and changes no model policy. Profile defaults remain available.</p>
  </div>;
}
