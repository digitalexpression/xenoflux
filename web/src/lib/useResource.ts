import { useCallback, useEffect, useRef, useState } from 'react';

export interface Resource<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload: () => void;
  setData: (value: T) => void;
}

/** Load once per key; keeps the last data visible while reloading. */
export function useResource<T>(load: () => Promise<T>, key: string): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [generation, setGeneration] = useState(0);
  const latest = useRef(load);
  latest.current = load;

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    latest.current().then(
      value => { if (current) { setData(value); setLoading(false); } },
      (reason: unknown) => { if (current) { setError(reason instanceof Error ? reason : new Error(String(reason))); setLoading(false); } },
    );
    return () => { current = false; };
  }, [key, generation]);

  const reload = useCallback(() => setGeneration(value => value + 1), []);
  return { data, error, loading, reload, setData };
}
