import { useCallback, useEffect, useRef, useState } from 'react';

export interface Resource<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload: () => Promise<boolean>;
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
  const request = useRef<Resource<T>['reload'] | null>(null);
  latest.current = load;
  paused.current = policy.paused;

  useEffect(() => {
    let current = true;
    let inFlight = false;
    let reloadQueued = false;
    const reloadWaiters: Array<(accepted: boolean) => void> = [];

    function settleReloads(accepted: boolean) {
      for (const resolve of reloadWaiters.splice(0)) resolve(accepted);
    }

    async function read(background: boolean) {
      if (!current || (background && (paused.current || document.visibilityState === 'hidden' || inFlight))) return;
      if (!background) { setLoading(true); setError(null); }
      if (inFlight) { reloadQueued = true; return; }
      inFlight = true;
      const loader = latest.current;
      let accepted = false;
      try {
        const value = await Promise.resolve().then(() => loader({ background }));
        if (current && !reloadQueued) {
          setData(value);
          setError(null);
          accepted = true;
        }
      } catch (reason) {
        if (current && !reloadQueued) {
          const error = reason instanceof Error
            ? reason
            : new Error(typeof reason === 'string' ? reason : 'Resource read failed', { cause: reason });
          setError(error);
        }
      } finally {
        inFlight = false;
        if (current) {
          if (reloadQueued) {
            reloadQueued = false;
            void read(false);
          } else {
            setLoading(false);
            settleReloads(accepted);
          }
        }
      }
    }
    request.current = () => new Promise(resolve => {
      reloadWaiters.push(resolve);
      void read(false);
    });
    void read(false);
    const check = () => { void read(true); };
    const timer = policy.live ? window.setInterval(check, 5_000) : undefined;
    if (policy.live) {
      window.addEventListener('focus', check);
      document.addEventListener('visibilitychange', check);
    }
    return () => {
      current = false;
      request.current = null;
      settleReloads(false);
      window.clearInterval(timer);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [key, policy.live]);

  const reload = useCallback(() => request.current?.() ?? Promise.resolve(false), []);
  return { data, error, loading, reload, setData };
}
