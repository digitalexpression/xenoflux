import { useEffect, useState } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { apiGet, exchangeLaunchToken, ApiError } from './api/client';
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
    exchangeLaunchToken(window.location, window.history).then(load, setError);
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
        <ErrorPanel title={unauthorized ? 'Open Xenoflux from its launch link' : 'Xenoflux isn’t running'}>
          {unauthorized
            ? 'For your safety this page only works when opened by xfx ui. Run xfx ui again; it opens the app with a fresh link.'
            : 'This page can’t reach the local app. The last run state is unknown. Start Xenoflux again with xfx ui and check progress; interrupted tasks are never restarted automatically.'}
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
