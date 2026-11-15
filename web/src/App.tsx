import { useEffect, useState } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { apiGet, ApiError } from './api/client';
import { host } from './host';
import type { Info } from './api/types';
import { InfoContext } from './components/layout';
import { ErrorPanel } from './components/notices';
import { routes } from './routes';

const router = createBrowserRouter(routes);

export function App() {
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);

  useEffect(() => {
    const load = () => apiGet<Info>('/api/info').then(value => { setInfo(value); setError(null); }, setError);
    host.boot().then(load, setError);
    // The run banner reflects runs started elsewhere; refresh it gently.
    const refresh = window.setInterval(() => { void apiGet<Info>('/api/info').then(setInfo, () => {}); }, 15000);
    const changed = () => { void load(); };
    window.addEventListener('xenoflux-info-changed', changed);
    return () => { window.clearInterval(refresh); window.removeEventListener('xenoflux-info-changed', changed); };
  }, []);

  if (error && !info) {
    const unauthorized = error instanceof ApiError && error.status === 401;
    return (
      <main className="page">
        <ErrorPanel title={(unauthorized ? host.unauthorized : host.unreachable).title}>
          {(unauthorized ? host.unauthorized : host.unreachable).body}
        </ErrorPanel>
      </main>
    );
  }
  if (!info) return <main className="page"><p className="hint" role="status">Starting Xenoflux…</p></main>;
  return (
    <InfoContext.Provider value={info}>
      <RouterProvider router={router} />
    </InfoContext.Provider>
  );
}
