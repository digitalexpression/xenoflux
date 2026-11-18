import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoProvider } from '../src/ui-demo.js';
import { uiRoutes } from '../src/ui-server.js';

test('demo client icons are all null and the demo reveal never opens Finder', async () => {
  const provider = createDemoProvider();
  assert.deepEqual(await provider.clientIcons(), { codex: null, 'claude-code': null, copilot: null });
  assert.deepEqual(await provider.revealProfileFolder({ name: 'baseline', client: 'codex' }),
    { status: 'neutral', message: 'Simulated: Finder was not opened.' });
});

test('the reveal route reaches the provider and rejects an unknown profile', async () => {
  const provider = createDemoProvider();
  const route = uiRoutes(provider).find(item => item.method === 'POST' && item.match('/api/profiles/missing/reveal'));
  assert.ok(route);
  await assert.rejects(route.handler({ params: route.match('/api/profiles/missing/reveal'), body: { client: 'codex' }, query: new URLSearchParams() }),
    { status: 404 });
  const icons = uiRoutes(provider).find(item => item.method === 'GET' && item.match('/api/clients/icons'));
  assert.deepEqual(await icons.handler({ params: {}, query: new URLSearchParams() }), { codex: null, 'claude-code': null, copilot: null });
});
