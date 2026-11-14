import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { apiPost } from '@/api/client';
import type { NativeClientId, SavedSummary, Side } from '@/api/types';
import { Button } from '@/components/ui/button';

type Selection = { key: string } | { client: NativeClientId; token: string } | { report: string; side: Side };

export function InspectSessionButton({ selection, label = 'Inspect session', disabled = false, compareWith }: {
  selection: Selection; label?: string; disabled?: boolean; compareWith?: string;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const selectionKey = JSON.stringify([selection, compareWith]);
  useEffect(() => {
    generation.current++;
    setBusy(false); setError('');
    return () => { generation.current++; };
  }, [selectionKey]);
  async function inspect() {
    if (busy) return;
    const owner = generation.current;
    setBusy(true); setError('');
    try {
      const result = await apiPost<SavedSummary>('/api/sessions/inspect', selection);
      if (generation.current !== owner) return;
      if (compareWith) {
        const pair = await apiPost<SavedSummary>('/api/compare/inspections', { left: compareWith, right: result.ref });
        if (generation.current === owner) navigate(`/reports/${encodeURIComponent(pair.ref)}`);
      } else navigate(result.href ?? `/sessions/${encodeURIComponent(result.ref)}`);
    } catch (reason) { if (generation.current === owner) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (generation.current === owner) setBusy(false); }
  }
  return <div className="flex flex-col gap-2 min-w-0">
    <Button disabled={disabled} busy={busy} busyLabel={compareWith ? 'Comparing sessions…' : 'Reading session…'} onClick={() => void inspect()}>{label}</Button>
    {error ? <p className="text-ui wrap-anywhere" role="alert">{error}</p> : null}
  </div>;
}
