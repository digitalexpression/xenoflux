import { ApiError } from '@/api/error';

/**
 * Everything the UI needs from whatever hosts it. The browser host is the
 * supported one; a native window can supply its own by setting
 * `window.__XENOFLUX_HOST__` before the app script runs.
 */
export interface Host {
  kind: 'browser' | 'desktop';
  /** Establish the app session before the first API read. */
  boot(): Promise<void>;
  setTitle(title: string): void;
  /** Appended to "not answering" errors: how to bring the local app back. */
  restartHint: string;
  /** Shown when the session was not established by this host's launch path. */
  unauthorized: { title: string; body: string };
  /** Shown when the local app cannot be reached at startup. */
  unreachable: { title: string; body: string };
}

const REQUEST_HEADERS = { 'x-xenoflux-request': '1', 'content-type': 'application/json' };

/** Exchange the launch token from the URL fragment for a session cookie, then drop it from history. */
async function exchangeLaunchToken(): Promise<void> {
  const match = /(?:^#|&)launch=([\w-]+)/.exec(window.location.hash);
  if (!match) return;
  window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  let response: Response;
  try {
    response = await fetch('/api/session', { method: 'POST', headers: REQUEST_HEADERS, credentials: 'same-origin', body: JSON.stringify({ token: match[1] }) });
  } catch {
    throw new ApiError(0, `The local Xenoflux server is not answering. ${browserHost.restartHint}`, 'offline');
  }
  // Always read the body: an unread response keeps the request open.
  const text = await response.text();
  if (response.ok) return;
  let body: { error?: { message?: string; code?: string; details?: unknown } } | null = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* reported below */ }
  throw new ApiError(response.status, body?.error?.message ?? `The local app answered ${response.status}.`, body?.error?.code ?? 'http', body?.error?.details);
}

export const browserHost: Host = {
  kind: 'browser',
  boot: exchangeLaunchToken,
  setTitle(title) { document.title = title; },
  restartHint: 'If you stopped it, run xfx ui again.',
  unauthorized: {
    title: 'Open Xenoflux from its launch link',
    body: 'For your safety this page only works when opened by xfx ui. Run xfx ui again; it opens the app with a fresh link.',
  },
  unreachable: {
    title: 'Xenoflux isn’t running',
    body: 'This page can’t reach the local app. The last run state is unknown. Start Xenoflux again with xfx ui and check progress; interrupted tasks are never restarted automatically.',
  },
};

declare global {
  interface Window { __XENOFLUX_HOST__?: Partial<Host> }
}

export const host: Host = { ...browserHost, ...(typeof window === 'undefined' ? {} : window.__XENOFLUX_HOST__) };
