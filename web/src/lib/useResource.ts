import { useCallback, useEffect, useRef, useState } from 'react';

export interface Resource<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload: () => void;
  setData: (value: T) => void;
}
interface ResourceRead { background: boolean }
interface ResourcePolicy { live?: boolean; paused?: boolean }

/** Load once per key, with optional quiet checks while the page is visible. */
export function useResource<T>(load: (read: ResourceRead) => Promise<T>, key: string, policy: ResourcePolicy = {}): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const latest = useRef(load);
  const paused = useRef(policy.paused);
  const request = useRef<() => void>(() => {});
  latest.current = load;
  paused.current = policy.paused;

  useEffect(() => {
    let current = true;
    let inFlight = false;
    let queued = false;
    let revision = 0;
    function read(background: boolean) {
      if (!current || (background && (paused.current || document.visibilityState === 'hidden' || inFlight))) return;
      const version = ++revision;
      if (!background) { setLoading(true); setError(null); }
      if (inFlight) { queued = true; return; }
      inFlight = true;
      const loader = latest.current;
      void Promise.resolve().then(() => loader({ background })).then(
        value => { if (current && version === revision) { setData(value); setError(null); } },
        (reason: unknown) => { if (current && version === revision) setError(reason instanceof Error ? reason : new Error(String(reason))); },
      ).finally(() => {
        inFlight = false;
        if (!current) return;
        if (queued) { queued = false; read(false); }
        else setLoading(false);
      });
    }
    request.current = () => read(false);
    read(false);
    const check = () => read(true);
    const timer = policy.live ? window.setInterval(check, 5_000) : undefined;
    if (policy.live) {
      window.addEventListener('focus', check);
      document.addEventListener('visibilitychange', check);
    }
    return () => {
      current = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [key, policy.live]);

  const reload = useCallback(() => request.current(), []);
  return { data, error, loading, reload, setData };
}
