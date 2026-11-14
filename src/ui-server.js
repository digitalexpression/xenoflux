// Loopback-only server for the local web app. It serves the built frontend and
// a narrow JSON API over one provider (engine or demo) from the same origin.
// Access needs the per-launch token, exchanged once for an HttpOnly cookie;
// Host and Origin checks block DNS rebinding and cross-site requests.
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

export class UiError extends Error {
  constructor(status, message, code = 'error', details) {
    super(message);
    this.status = status; this.code = code; this.details = details;
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};
const CSP = ["default-src 'self'", "script-src 'self'", "style-src 'self'", "style-src-attr 'unsafe-inline'", "img-src 'self' data:",
  "font-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"].join('; ');
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const REQUEST_HEADER = 'x-xenoflux-request';

// These paths are rendered by React Router. Some identifiers contain dots
// (for example, a profile name or an encoded frozen report reference), so a
// filename-extension check cannot tell them apart from static assets.
function isClientRoute(path) {
  return /^\/(?:profiles(?:\/[^/]+(?:\/copy)?)?|compare(?:\/.*)?|sessions(?:\/.*)?|reports(?:\/.*)?|runs(?:\/.*)?)$/.test(path);
}

export const randomToken = () => randomBytes(32).toString('base64url');

function equalSecret(a, b) {
  const left = Buffer.from(String(a ?? '')), right = Buffer.from(String(b ?? ''));
  return left.length === right.length && timingSafeEqual(left, right);
}

function cookies(header = '') {
  return Object.fromEntries(header.split(';').map(part => part.trim().split('=')).filter(([key, value]) => key && value !== undefined)
    .map(([key, ...rest]) => [key, rest.join('=')]));
}

function securityHeaders(response) {
  response.setHeader('Content-Security-Policy', CSP);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

function sendJson(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  response.end(body);
}

async function readBody(request, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new UiError(413, 'The request is too large.', 'too-large');
    chunks.push(chunk);
  }
  if (!size) return {};
  if (!/^application\/json\b/i.test(request.headers['content-type'] ?? '')) throw new UiError(415, 'Send JSON.', 'unsupported-type');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new UiError(400, 'The request body is not valid JSON.', 'invalid-json'); }
}

/** Compile `/api/x/:name` patterns into matchers; parameters are URI-decoded. */
function route(method, pattern, handler, { bodyLimit = 1 << 20 } = {}) {
  const names = [];
  const source = pattern.replace(/:(\w+)/g, (_, name) => { names.push(name); return '([^/]+)'; });
  const regex = new RegExp(`^${source}$`);
  return { method, handler, bodyLimit, match(path) {
    const found = regex.exec(path);
    if (!found) return null;
    try { return Object.fromEntries(names.map((name, i) => [name, decodeURIComponent(found[i + 1])])); }
    catch { return null; }
  } };
}

/** Routes map 1:1 to provider operations; the provider validates its own inputs. */
export function uiRoutes(provider) {
  const call = (name, pick) => async context => {
    if (typeof provider[name] !== 'function') throw new UiError(404, 'This action is not available in this build.', 'not-available');
    return provider[name](pick(context));
  };
  const q = ({ query }) => Object.fromEntries(query);
  return [
    route('GET', '/api/info', call('info', () => ({}))),
    route('GET', '/api/catalog', call('catalog', q)),
    route('GET', '/api/apps', call('apps', ({ query }) => ({ fresh: query.get('fresh') === '1' }))),
    route('POST', '/api/apps/open', call('openApp', ({ body }) => body)),
    route('POST', '/api/catalog/refresh', call('refreshCatalog', ({ body }) => body)),
    route('POST', '/api/catalog/cancel', call('cancelCatalog', ({ body }) => body)),
    route('GET', '/api/overview', call('overview', () => ({}))),
    route('GET', '/api/discovery', call('discovery', ({ query }) => ({ fresh: query.get('fresh') === '1' }))),
    route('GET', '/api/profiles', call('profiles', () => ({}))),
    route('GET', '/api/setups/options', call('setupChoices', () => ({}))),
    route('GET', '/api/profiles/:name/setup', call('profileSetup', ({ params, query }) => ({ ...q({ query }), name: params.name }))),
    route('POST', '/api/profiles/:name/clients', call('clientAction', ({ params, body }) => ({ name: params.name, ...body }))),
    route('POST', '/api/profiles/:name/account', call('profileAccount', ({ params, body }) => ({ name: params.name, client: body?.client })), { bodyLimit: 2048 }),
    route('GET', '/api/profiles/:name/copy', call('copyPlan', ({ params, query }) => ({ target: params.name, ...q({ query }) }))),
    route('POST', '/api/profiles/:name/copy', call('copyApply', ({ params, body }) => ({ target: params.name, ...body }))),
    route('POST', '/api/copies/:id/undo', call('copyUndo', ({ params, body }) => ({ id: params.id, ...body }))),
    route('GET', '/api/profiles/new', call('createPlan', q)),
    route('POST', '/api/profiles/new', call('createApply', ({ body }) => body)),
    route('POST', '/api/profiles/:name/rename', call('renameProfile', ({ params, body }) => ({ name: params.name, ...body }))),
    route('POST', '/api/profiles/:name/binding', call('bindProfile', ({ params, body }) => ({ name: params.name, ...body }))),
    route('POST', '/api/profiles/:name/remove', call('removeProfile', ({ params, body }) => ({ name: params.name, ...body }))),
    route('GET', '/api/compare/setups', call('setupComparison', q)),
    route('GET', '/api/compare/setups/skills/:skill', call('skillDetail', ({ params, query }) => ({ skill: params.skill, ...q({ query }) }))),
    route('GET', '/api/sessions', call('sessions', q)),
    route('POST', '/api/sessions/inspect', call('inspectSession', ({ body }) => body), { bodyLimit: 2048 }),
    route('GET', '/api/sessions/inspect/:ref', call('sessionInspection', ({ params }) => params)),
    route('GET', '/api/sessions/codex', call('codexSessions', q)),
    route('GET', '/api/sessions/copilot', call('copilotSessions', q)),
    route('GET', '/api/sessions/claude-code', call('claudeSessions', q)),
    route('GET', '/api/compare/sessions/association', call('association', q)),
    route('POST', '/api/compare/sessions/import', call('importListedComparison', ({ body }) => body), { bodyLimit: 2 << 10 }),
    route('POST', '/api/compare/sessions', call('compareSessions', ({ body }) => body)),
    route('POST', '/api/compare/inspections', call('compareInspections', ({ body }) => body), { bodyLimit: 2048 }),
    route('GET', '/api/reports/recent', call('savedReports', () => ({}))),
    route('POST', '/api/reports/open', call('openReport', ({ body }) => body), { bodyLimit: 64 << 20 }),
    route('POST', '/api/reports/import/copilot', call('importCopilotComparison', ({ body }) => body), { bodyLimit: 2 << 10 }),
    route('POST', '/api/reports/import/claude-code', call('importClaudeComparison', ({ body }) => body), { bodyLimit: 40 << 20 }),
    route('POST', '/api/reports/recent/:id/open', call('openRecentReport', ({ params }) => ({ id: params.id }))),
    route('GET', '/api/reports/:ref', call('report', ({ params }) => ({ ref: params.ref }))),
    route('GET', '/api/reports/:ref/reviews', call('reviews', ({ params }) => ({ ref: params.ref }))),
    route('POST', '/api/reports/:ref/reviews/preview', call('previewReview', ({ params, body }) => ({ ref: params.ref, submission: body?.submission })), { bodyLimit: 2 << 20 }),
    route('POST', '/api/reports/:ref/reviews', call('saveReview', ({ params, body }) => ({ ref: params.ref, token: body?.token }))),
    route('POST', '/api/reports/:ref/review-tasks/preview',
      call('previewReviewTask', ({ params, body }) => ({ ...body, ref: params.ref })), { bodyLimit: 2 << 20 }),
    route('POST', '/api/reports/:ref/review-tasks',
      call('startReviewTask', ({ params, body }) => ({ ref: params.ref, previewToken: body?.previewToken })), { bodyLimit: 16 << 10 }),
    route('GET', '/api/review-tasks/:id', call('reviewTask', ({ params }) => ({ id: params.id }))),
    route('POST', '/api/review-tasks/:id/cancel', call('cancelReviewTask', ({ params }) => ({ id: params.id })), { bodyLimit: 16 << 10 }),
    route('POST', '/api/review-tasks/:id/requests/:requestId',
      call('respondReviewTask', ({ params, body }) => ({ id: params.id, requestId: params.requestId, response: body?.response })),
      { bodyLimit: 1 << 20 }),
    route('GET', '/api/reports/:ref/export', call('exportPlan', ({ params, query }) => ({ ref: params.ref, ...q({ query }) }))),
    route('POST', '/api/reports/:ref/export', call('exportReport', ({ params, body }) => ({ ref: params.ref, ...body }))),
    route('GET', '/api/runs/new', call('runOptions', () => ({}))),
    route('POST', '/api/runs/preview', call('runPreview', ({ body }) => body)),
    route('POST', '/api/runs', call('startRun', ({ body }) => body)),
    route('GET', '/api/runs/:id', call('run', ({ params }) => ({ id: params.id }))),
    route('POST', '/api/runs/:id/requests/:requestId',
      call('respondRun', ({ params, body }) => ({ ...params, response: body?.response })), { bodyLimit: 1 << 20 }),
    route('POST', '/api/runs/:id/cancel', call('cancelRun', ({ params }) => ({ id: params.id }))),
    route('POST', '/api/runs/:id/recover', call('recoverRun', ({ params, body }) => ({ id: params.id, ...body }))),
  ];
}

async function staticFile(root, path) {
  const relativePath = decodeURIComponent(path).replace(/^\/+/, '');
  if (relativePath.split('/').some(part => part === '..' || part.startsWith('.'))) return null;
  const candidate = resolve(root, relativePath || 'index.html');
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  try {
    const real = await realpath(candidate);
    if (real !== candidate) return null;
    const handle = await open(real, 'r');
    const info = await handle.stat();
    if (!info.isFile()) { await handle.close(); return null; }
    return { handle, size: info.size, type: TYPES[extname(real)] ?? 'application/octet-stream', immutable: real.includes(`${sep}assets${sep}`) };
  } catch { return null; }
}

/**
 * Start the server. `port` 0 picks a free port. Returns the origin, the launch
 * URL (token in the fragment, never sent in requests) and `close()`.
 */
export async function startUiServer({ provider, staticRoot, port = 0, host = '127.0.0.1', launchToken = randomToken(), log = () => {} }) {
  if (!['127.0.0.1', '::1'].includes(host)) throw new Error('The UI server binds to loopback only');
  const root = staticRoot ? await realpath(staticRoot) : null;
  const sessions = new Set();
  const routes = uiRoutes(provider);
  let origins = [], cookieName = '';

  const server = createServer(async (request, response) => {
    securityHeaders(response);
    try {
      const hostHeader = request.headers.host ?? '';
      if (!origins.some(origin => origin === `http://${hostHeader}`)) {
        response.writeHead(421, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Xenoflux only answers requests addressed to its own local address.');
        return;
      }
      const url = new URL(request.url ?? '/', `http://${hostHeader}`);
      if (url.pathname.startsWith('/api/')) await api(request, response, url);
      else await serveStatic(request, response, url);
    } catch (error) {
      if (!(error instanceof UiError)) log(`ui: ${error?.stack ?? error}`);
      if (response.headersSent) { response.destroy(); return; }
      const status = error instanceof UiError ? error.status : 500;
      sendJson(response, status, { error: { message: error instanceof UiError ? error.message : String(error?.message ?? 'Unexpected error'),
        code: error instanceof UiError ? error.code : 'internal', ...(error?.details ? { details: error.details } : {}) } });
    }
  });

  async function api(request, response, url) {
    const method = request.method ?? 'GET';
    if (request.headers[REQUEST_HEADER] !== '1') throw new UiError(403, 'Requests must come from the Xenoflux app.', 'forbidden');
    if (MUTATING.has(method) && !origins.includes(request.headers.origin ?? '')) throw new UiError(403, 'Cross-site requests are refused.', 'forbidden');
    if (url.pathname === '/api/session' && method === 'POST') {
      const body = await readBody(request, 4096);
      if (!equalSecret(body.token, launchToken)) throw new UiError(401, 'This launch link is not valid. Run xfx ui again to open the app.', 'unauthorized');
      const id = randomToken();
      sessions.add(id);
      sendJson(response, 200, { ok: true }, { 'Set-Cookie': `${cookieName}=${id}; HttpOnly; SameSite=Strict; Path=/` });
      return;
    }
    const session = cookies(request.headers.cookie)[cookieName];
    if (!session || ![...sessions].some(id => equalSecret(id, session))) throw new UiError(401, 'Open the app with xfx ui to continue.', 'unauthorized');
    if (url.pathname === '/api/health') { sendJson(response, 200, { ok: true }); return; }
    for (const candidate of routes) {
      if (candidate.method !== method) continue;
      const params = candidate.match(url.pathname);
      if (!params) continue;
      const body = MUTATING.has(method) ? await readBody(request, candidate.bodyLimit) : {};
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new UiError(400, 'Send a JSON object.', 'invalid-json');
      const value = await candidate.handler({ params, query: url.searchParams, body });
      sendJson(response, 200, value ?? { ok: true });
      return;
    }
    throw new UiError(404, 'Unknown request.', 'not-found');
  }

  async function serveStatic(request, response, url) {
    if (!['GET', 'HEAD'].includes(request.method ?? '')) throw new UiError(405, 'Method not allowed.', 'method');
    if (!root) {
      response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('The Xenoflux app is not built. Run npm run build:ui in the source checkout.');
      return;
    }
    // Serve real files first. App routes can contain dots in their IDs; only
    // fall back to the shell for known route families (or legacy extensionless
    // paths), while a missing asset continues to return 404.
    let file = await staticFile(root, url.pathname);
    if (!file && (isClientRoute(url.pathname) || !extname(url.pathname))) file = await staticFile(root, 'index.html');
    if (!file) { response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('Not found'); return; }
    response.writeHead(200, { 'Content-Type': file.type, 'Content-Length': file.size,
      'Cache-Control': file.immutable ? 'public, max-age=31536000, immutable' : 'no-store' });
    if (request.method === 'HEAD') { await file.handle.close(); response.end(); return; }
    const stream = file.handle.createReadStream();
    stream.pipe(response);
    await new Promise(done => stream.once('close', done));
  }

  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolveListen(); });
  });
  const actualPort = server.address().port;
  origins = [`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`];
  if (host === '::1') origins = [`http://[::1]:${actualPort}`, `http://localhost:${actualPort}`];
  cookieName = `xfx_ui_${actualPort}`;
  const origin = origins[0];
  return {
    origin, port: actualPort,
    launchUrl: `${origin}/#launch=${launchToken}`,
    close: () => new Promise(done => { server.closeAllConnections?.(); server.close(() => done()); }),
  };
}
