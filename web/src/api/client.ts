import type { ApiErrorBody } from './types';

export class ApiError extends Error {
  constructor(public status: number, message: string, public code: string, public details?: unknown) {
    super(message);
  }
}

const HEADERS = { 'x-xenoflux-request': '1' };

async function parse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* reported below */ }
  if (!response.ok) {
    const error = (body as ApiErrorBody | null)?.error;
    throw new ApiError(response.status, error?.message ?? `The local app answered ${response.status}.`, error?.code ?? 'http', error?.details);
  }
  return body as T;
}

export async function apiGet<T>(path: string, params?: Record<string, string | undefined>): Promise<T> {
  const query = params ? new URLSearchParams(Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== '')) : null;
  const url = query && [...query].length ? `${path}?${query}` : path;
  let response: Response;
  try { response = await fetch(url, { headers: HEADERS, credentials: 'same-origin' }); }
  catch { throw new ApiError(0, 'The local Xenoflux server is not answering. If you stopped it, run xfx ui again.', 'offline'); }
  return parse<T>(response);
}

export async function apiPost<T>(path: string, body: unknown = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
  } catch { throw new ApiError(0, 'The local Xenoflux server is not answering. If you stopped it, run xfx ui again.', 'offline'); }
  return parse<T>(response);
}

/** Exchange the launch token from the URL fragment for a session cookie, then drop it from history. */
export async function exchangeLaunchToken(location: Location, history: History): Promise<void> {
  const match = /(?:^#|&)launch=([\w-]+)/.exec(location.hash);
  if (!match) return;
  history.replaceState(history.state, '', location.pathname + location.search);
  await apiPost('/api/session', { token: match[1] });
}
