import { useEffect, useEffectEvent, useId, useRef, useState } from 'react';
import { ChevronDown, Database } from 'lucide-react';
import { ApiError, apiGet, apiPost } from '@/api/client';
import type { ExecutionSelection, ModelCatalogSnapshot, NativeClientId, PermissionMode } from '@/api/types';
import { Button } from '@/components/ui/button';

type CatalogState = { context: string; snapshot: ModelCatalogSnapshot | null; busy: boolean; message: string; fromPassiveRead?: true; errorCode?: string };
type CatalogContext = { profile: string; client?: NativeClientId; workspace: string; autoLoad?: boolean; revision?: number };
type ExecutionProps = CatalogContext & {
  value: ExecutionSelection; onChange: (value: ExecutionSelection) => void;
  disabled?: boolean; allowPermissionMode?: boolean;
};

export function useExecutionCatalog({ profile, client, workspace, autoLoad = false, revision = 0 }: CatalogContext) {
  const context = JSON.stringify([profile, client, workspace, revision]);
  const currentContext = useRef(context);
  currentContext.current = context;
  const generation = useRef(0);
  const activeRefresh = useRef<{ requestId: string; automatic: boolean } | null>(null);
  const [state, setState] = useState<CatalogState>({ context, snapshot: null, busy: false, message: '' });
  const [now, setNow] = useState(Date.now());
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    const owner = ++generation.current;
    setCancelling(false);
    setState({ context, snapshot: null, busy: false, message: profile ? 'Checking saved model catalog…' : 'Choose a profile to discover its models.' });
    if (profile) {
      apiGet<ModelCatalogSnapshot>('/api/catalog', { profile, workspace, ...(client ? { client } : {}) }).then(snapshot => {
        if (currentContext.current === context && generation.current === owner)
          setState({ context, snapshot, busy: false, message: '', fromPassiveRead: true });
      }).catch(error => {
        if (currentContext.current === context && generation.current === owner)
          setState({ context, snapshot: null, busy: false, message: String(error.message), errorCode: error instanceof ApiError ? error.code : undefined });
      });
    }
    return () => {
      generation.current++;
      if (activeRefresh.current) {
        void apiPost('/api/catalog/cancel', { requestId: activeRefresh.current.requestId }).catch(() => {});
        activeRefresh.current = null;
      }
    };
  }, [context, client, profile, workspace]);

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
  const models = ready ? snapshot.models.filter(model => !model.hidden && model.selectable !== false) : [];
  const routes = ready && client === 'copilot' ? snapshot.auto?.tiers.filter(tier => tier.type === 'auto' && tier.enabled && tier.visible) ?? [] : [];
  const defaultRoute = routes.find(route => route.id === snapshot?.auto?.defaultTier);
  const modes = (!client || client === 'codex' || ready) ? snapshot?.permissionModes ?? snapshot?.capabilities?.permissionModes ?? [] : [];
  const busy = state.context === context && state.busy;

  async function refresh(automatic = false) {
    if (activeRefresh.current || !profile) return;
    const owner = ++generation.current, requestId = crypto.randomUUID();
    activeRefresh.current = { requestId, automatic };
    setState({ context, snapshot: null, busy: true, message: 'Refreshing models…' });
    try {
      const result = await apiPost<ModelCatalogSnapshot>('/api/catalog/refresh', { profile, workspace, ...(client ? { client } : {}), requestId });
      if (currentContext.current === context && generation.current === owner)
        setState({ context, snapshot: result, busy: false, message: '' });
    } catch (error) {
      if (currentContext.current === context && generation.current === owner)
        setState({ context, snapshot: null, busy: false, message: error instanceof Error ? error.message : 'Model discovery failed. Try refreshing again.',
          errorCode: error instanceof ApiError ? error.code : undefined });
    } finally {
      if (activeRefresh.current?.requestId === requestId && generation.current === owner) activeRefresh.current = null;
    }
  }
  const autoRefresh = useEffectEvent(() => refresh(true));
  const shouldAutoLoad = autoLoad && state.fromPassiveRead && snapshot?.status === 'unavailable' &&
    (snapshot.reason === 'catalog-not-refreshed' || snapshot.reason === 'catalog-expired');
  useEffect(() => {
    if (shouldAutoLoad) void autoRefresh();
  }, [shouldAutoLoad]);

  async function cancel() {
    const requestId = activeRefresh.current?.requestId;
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
      : snapshot?.status === 'cancelled' ? 'Model refresh cancelled.'
        : snapshot?.reason === 'catalog-context-changed' ? 'Profile setup changed during discovery. Refresh models again before choosing a model.'
          : snapshot?.reason === 'catalog-not-refreshed' || !snapshot ? 'No saved model catalog.' : 'Model catalog unavailable. Refresh models to try again.');

  const errorCode = state.context === context ? state.errorCode : undefined;
  const cancelAutomatic = () => { if (activeRefresh.current?.automatic) void cancel(); };
  return { snapshot, models, routes, defaultRoute, modes, busy, cancelling, message, errorCode, refresh, cancel, cancelAutomatic };
}

type Catalog = ReturnType<typeof useExecutionCatalog>;

export function useExecutionControls({ profile, client, value, onChange, disabled, allowPermissionMode = true, side, catalog, shared }: Omit<ExecutionProps, 'workspace'> & {
  side?: 'Left' | 'Right'; catalog: Catalog; shared?: boolean;
}) {
  const id = useId();
  const { snapshot, models, routes, defaultRoute, modes, busy, cancelling, message, refresh, cancel } = catalog;
  const selected = value.model ? models.find(model => model.model === value.model) : models.find(model => model.isDefault);
  const efforts = selected?.supportedReasoningEfforts ?? [];
  const labelClass = side ? 'sr-only' : 'field-label';
  const effortHint = selected?.supportedReasoningEfforts === null ? 'Effort support is unknown.' : selected && !efforts.length ? 'No explicit efforts advertised.' : !selected ? 'Effort choices depend on the model catalog.' : 'Efforts advertised for this model.';
  const permissionHint = modes.length ? 'Applies only to this job.' : 'Explicit permission choices are unavailable for this context.';

  const model = <div className="flex-1 min-w-0">
        <label className={labelClass} htmlFor={`${id}-model`}>Model ID{side ? ` · ${side}` : ''}</label>
        <select id={`${id}-model`} className="input font-mono" value={value.model ?? ''} disabled={disabled}
          aria-describedby={`${id}-catalog`} onChange={event => onChange({ permissionMode: value.permissionMode, model: event.target.value || undefined,
            ...(event.target.value === 'auto' && !defaultRoute ? { route: routes[0]?.id } : {}) })}>
          <option value="">Use profile default</option>
          {routes.length ? <option value="auto">Auto · Copilot routing</option> : null}
          {value.model && !(value.model === 'auto' && routes.length) && !models.some(model => model.model === value.model) ? <option value={value.model} disabled>{value.model} · unverified</option> : null}
          {models.map(model => <option key={model.id} value={model.model}>{model.displayName || model.model} · {model.model}</option>)}
        </select>
      </div>;
  const effort = <div className="flex-1 min-w-0">
        <label className={labelClass} htmlFor={`${id}-effort`}>Reasoning effort{side ? ` · ${side}` : ''}</label>
        <select id={`${id}-effort`} className="input" value={value.reasoningEffort ?? ''} disabled={disabled}
          aria-describedby={`${id}-effort-hint`} onChange={event => onChange({ ...value, reasoningEffort: event.target.value || undefined })}>
          <option value="">Use profile default</option>
          {value.reasoningEffort && !efforts.some(effort => effort.reasoningEffort === value.reasoningEffort) ? <option value={value.reasoningEffort} disabled>{value.reasoningEffort} · unverified</option> : null}
          {efforts.map(effort => <option key={effort.reasoningEffort} value={effort.reasoningEffort}>{effort.reasoningEffort}{effort.description ? ` · ${effort.description}` : ''}</option>)}
        </select>
        <p id={`${id}-effort-hint`} className={side ? 'sr-only' : 'hint mt-1'}>{effortHint}</p>
      </div>;
  const route = value.model === 'auto' ? <div>
      <label className={labelClass} htmlFor={`${id}-route`}>Auto route{side ? ` · ${side}` : ''}</label>
      <select id={`${id}-route`} className="input" value={value.route ?? ''} disabled={disabled} aria-describedby={`${id}-auto-hint`} onChange={event => onChange({ ...value, route: event.target.value || undefined })}>
        {defaultRoute ? <option value="">Default · {defaultRoute.displayName}</option> : null}
        {value.route && !routes.some(route => route.id === value.route) ? <option disabled value={value.route}>{value.route} · unverified</option> : null}
        {routes.map(route => <option key={route.id} value={route.id}>{route.displayName}</option>)}
      </select>
      <p id={`${id}-auto-hint`} className="hint mt-1">Copilot can route each turn to a different model.</p>
    </div> : null;
  const permission = allowPermissionMode ? <div>
      <label className={labelClass} htmlFor={`${id}-permission`}>Permission mode{side ? ` · ${side}` : ''}</label>
      <select id={`${id}-permission`} className="input" value={value.permissionMode ?? ''} disabled={disabled}
        aria-describedby={`${id}-permission-hint`} onChange={event => onChange({ ...value, permissionMode: (event.target.value || undefined) as PermissionMode | undefined })}>
        <option value="">Use {client && client !== 'codex' ? 'profile default' : 'default permissions'}</option>
        {value.permissionMode && !modes.includes(value.permissionMode) ? <option value={value.permissionMode} disabled>{value.permissionMode} · unverified</option> : null}
        {modes.map(mode => <option key={mode} value={mode}>{mode}</option>)}
      </select>
      <p id={`${id}-permission-hint`} className={side ? 'sr-only' : 'hint'}>{permissionHint}</p>
    </div> : null;
  const status = <p id={`${id}-catalog`} className="meta wrap-anywhere" role="status">{shared ? 'Uses the Left model catalog.' : message}</p>;
  const cancelButton = busy ? <Button onClick={() => void cancel()} disabled={cancelling}>Cancel model refresh</Button> : null;
  const refreshButton = <Button onClick={() => void refresh()} disabled={disabled || !profile || busy || catalog.errorCode === 'profile-repository-unbound'} busy={busy} busyLabel="Refreshing models…">Refresh models</Button>;
  const provenance = snapshot?.discoveredAt ? <p className="meta wrap-anywhere">Source: {snapshot.source} · Retrieved {snapshot.discoveredAt} · Account identity: unknown.</p> : null;
  const effects = <p className="meta">Refresh initializes the native client and may use sign-in, write native state or run configured hooks. Profile defaults remain available.</p>;
  const catalogControls = side ? <div className="flex flex-col gap-1 min-w-0" role="region" aria-label={`${side} model catalog`}>
    {status}
    {shared ? null : <>
      <details className="run-catalog-details">
        <summary className="btn btn-link"><Database size={14} aria-hidden="true" /> Catalog details <ChevronDown size={14} aria-hidden="true" /></summary>
        <div className="flex flex-col gap-2 pb-2">
          {provenance}{effects}
          <div>{refreshButton}</div>
        </div>
      </details>
      {cancelButton ? <div>{cancelButton}</div> : null}
    </>}
  </div> : <>
    <div className="flex flex-wrap gap-3 items-center">{refreshButton}{cancelButton}</div>
    {status}{provenance}{effects}
  </>;

  return { model, effort, permission, route, catalogControls };
}

export function ExecutionFields(props: ExecutionProps) {
  const catalog = useExecutionCatalog(props);
  const fields = useExecutionControls({ ...props, catalog });
  return <div className="flex flex-col gap-3 min-w-0">
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(140px,100%),1fr))] gap-3">{fields.model}{fields.effort}</div>
    {fields.route}{fields.permission}{fields.catalogControls}
  </div>;
}
