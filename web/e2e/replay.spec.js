import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { createDemoProvider } from '../../src/ui-demo.js';
import { startUiServer } from '../../src/ui-server.js';

const event = (line, sessionId, label, timestamp, extra = {}) => ({
  id: `${sessionId}:${line}`, sessionId, turnId: `turn-${sessionId}`, kind: 'response-item', label, timestamp, sourceLine: line,
  body: null, bodyStatus: 'omitted', ...extra,
});

const inspectedCheck = (id, name, status, outputStatus = 'unavailable') => ({
  id, name, status, exitCode: status === 'failed' ? 1 : 0, origin: 'runner-check',
  definitionFingerprint: 'c'.repeat(64),
  definition: { command: 'npm test', purpose: 'Verify the recorded task.', timeoutMs: 120000, passCondition: 'Exit code 0' },
  execution: { startedAt: '2026-10-28T12:27:00.000Z', elapsedMs: 2300, workspaceFingerprint: 'd'.repeat(64) },
  output: { stdout: null, stderr: null, status: outputStatus, truncated: false }, detailNote: null,
});

function replay(side) {
  // Same exact session IDs and source fingerprints on each side stress side-aware UI identity.
  const offset = 1;
  const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const root = uuid(offset), worker1 = uuid(offset + 1), worker2 = uuid(offset + 2), missing = uuid(offset + 3);
  const start = '2026-10-28T12:26:35.251Z';
  const large = 'captured '.repeat(3000);
  return {
    schemaVersion: 1, kind: 'session-replay',
    sessions: [
      { id: root, parentId: null, depth: 0, status: 'ready', source: { fingerprint: 'a'.repeat(64) }, limits: [], events: [
        event(1, root, 'User message', start, { kind: 'message', role: 'user', body: 'Please inspect the failing test.', bodyStatus: 'included' }),
        event(2, root, 'Delegated parallel work', '2026-10-28T12:26:40.000Z', { body: `delegate workers ${large}`, bodyStatus: 'included', childSessionIds: [worker1, missing, worker2] }),
        event(3, root, 'Run check', '2026-10-28T12:26:45.000Z', { body: 'npm test', bodyStatus: 'included', callId: 'call-1', relatedEventId: `${root}:4` }),
        event(4, root, 'Check result', '2026-10-28T12:26:55.000Z', { body: large, bodyStatus: 'truncated', bodyReason: 'Fixture body was truncated.', relatedEventId: `${root}:3` }),
        ...Array.from({ length: 32 }, (_, index) => event(10 + index, root,
          index % 3 === 1 ? 'Assistant message' : 'User message',
          new Date(Date.parse('2026-10-28T12:26:36.000Z') + index * 550).toISOString(),
          { kind: 'message', role: index % 3 === 1 ? 'assistant' : 'user', turnId: `${root}-conversation-${Math.floor(index / 8) + 1}`,
            body: `Conversation line ${index + 1}: delegate ${'replay content '.repeat(8)}`, bodyStatus: 'included' })),
        event(5, root, 'Event with no timestamp', null, { bodyStatus: 'unavailable', bodyReason: 'Source body unavailable.' }),
        event(6, root, 'Private block omitted', '2026-10-28T12:26:54.000Z', { contentOmitted: true, bodyStatus: 'omitted', bodyReason: 'Private content was excluded.' }),
      ] },
      { id: worker1, parentId: root, depth: 1, status: 'ready', source: { fingerprint: 'b'.repeat(64) }, limits: [], events: [
        event(1, worker1, 'Worker one result', '2026-10-28T12:26:48.000Z'),
        event(2, worker1, 'Delegate nested worker', '2026-10-28T12:26:49.000Z', { body: 'delegate nested worker', bodyStatus: 'included', childSessionIds: [worker2] }),
      ] },
      { id: worker2, parentId: worker1, depth: 2, status: 'ready', source: { fingerprint: 'c'.repeat(64) }, limits: [], events: [
        event(1, worker2, 'Worker two result', '2026-10-28T12:26:49.000Z'),
      ] },
      { id: missing, parentId: root, depth: 1, status: 'unavailable', reason: 'Native child history unavailable.', source: { fingerprint: null }, limits: [], events: [] },
    ],
  };
}

async function focusInspectorAction(page, inspector, button) {
  await inspector.getByRole('heading', { name: 'Event inspector' }).focus();
  for (let steps = 0; steps < 12; steps++) {
    await page.keyboard.press('Tab');
    if (await button.evaluate(node => node === document.activeElement)) break;
  }
  await expect(button).toBeFocused();
}

test('replay presents independent trees, linked events and source gaps with keyboard navigation', async ({ browser }) => {
  const provider = createDemoProvider();
  const server = await startUiServer({ provider, staticRoot: resolve('dist/ui') });
  const page = await browser.newPage();
  try {
    await page.route('**/api/reports/demo-run', async route => {
      const view = await provider.report({ ref: 'demo-run' });
      await route.fulfill({ json: { ...view, replay: { a: replay('left'), b: replay('right') } } });
    });
    await page.goto(server.launchUrl);
    await page.getByRole('heading', { name: 'What do you want to compare?' }).waitFor();
    await page.goto(`${server.origin}/reports/demo-run`);
    await expect(page.getByRole('heading', { name: 'Session replay' })).toBeVisible();
    const leftTree = page.getByRole('region', { name: /baseline session tree/i });
    const inspector = page.getByRole('dialog', { name: 'Event inspector' });
    await expect(inspector).toHaveCount(0);
    const leftTranscript = leftTree.getByRole('region', { name: 'Conversation' });
    const rightTree = page.getByRole('region', { name: /strict-review session tree/i });
    const rightTranscript = rightTree.getByRole('region', { name: 'Conversation' });
    await expect(leftTranscript).toBeVisible();
    await expect(leftTranscript.locator('button[aria-current="true"][tabindex="0"]')).toHaveCount(1);
    await expect(rightTranscript).toBeVisible();
    await expect(leftTranscript.locator('[data-slot="message"]')).toHaveCount(33);
    const leftScroller = leftTranscript;
    const rightScroller = rightTranscript;
    await expect(leftScroller).toBeVisible();
    await expect(rightScroller).toBeVisible();
    const leftAtTop = await leftScroller.evaluate(node => node.scrollTop);
    await leftScroller.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await expect.poll(() => leftScroller.evaluate(node => node.scrollTop)).toBeGreaterThan(leftAtTop);
    await expect.poll(() => rightScroller.evaluate(node => node.scrollTop)).toBe(0);
    const lastRootEvent = leftTree.getByRole('button', { name: /Event with no timestamp/ });
    await lastRootEvent.focus();
    await page.keyboard.press('ArrowDown');
    await expect(leftTree.getByRole('button', { name: /Private block omitted/ })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(leftTree.getByRole('button', { name: /Worker one result/ })).toBeFocused();
    await expect(leftTree.getByRole('button', { name: /Worker one result/ })).toBeVisible();
    await leftTranscript.getByLabel('Child session 00000000-0000-4000-8000-000000000003 · ready').click();
    await expect(leftTree.getByRole('button', { name: /Worker two result/ })).toBeVisible();
    await leftTranscript.getByLabel('Child session 00000000-0000-4000-8000-000000000004 · unavailable · Native child history unavailable.').click();
    await expect(leftTree.getByText(/Activity unavailable: Native child history unavailable/)).toBeVisible();
    await expect(page.getByText(/root span \+0:20/).first()).toBeVisible();

    await page.getByRole('button', { name: /strict-review: User message/ }).first().click();
    await expect(inspector).toContainText('Right');

    const eventTree = page.getByRole('region', { name: /baseline session tree/i });
    const call = eventTree.getByRole('button', { name: /Run check/ }).first();
    await call.focus();
    await page.keyboard.press('ArrowDown');
    await expect(inspector).toBeVisible();
    await expect(inspector).toContainText('Check result');
    await expect(inspector).toContainText('truncated');
    await expect(inspector).toBeInViewport();
    const selectedResult = leftTranscript.getByRole('button', { name: /Check result ·/ });
    await expect(selectedResult).toBeFocused();
    await page.keyboard.press('F6');
    await expect(inspector.getByRole('heading', { name: 'Event inspector' })).toBeFocused();
    await page.keyboard.press('F6');
    await expect(selectedResult).toBeFocused();
    await expect(inspector).toBeVisible();
    await inspector.getByText('Source and event details').click();
    await expect(inspector.getByText(/Source fingerprint/)).toBeVisible();
    await page.getByText(/Show full recorded content/).click();
    await expect(inspector).toContainText('captured');
    await expect(inspector).toBeInViewport();
    await page.getByRole('searchbox', { name: 'Search recorded events' }).fill('Run check');
    await expect(leftTranscript.getByRole('button', { name: /Run check ·/ })).toHaveCount(1);
    await expect(leftTranscript.getByText(/^Turn /)).toHaveCount(1);
    await expect(rightTranscript.getByText(/^Turn /)).toHaveCount(1);
    await eventTree.getByRole('button', { name: /Run check/ }).first().click();
    await page.getByRole('button', { name: /Go to linked event/ }).click();
    await expect(inspector).toContainText('Check result');
    const linkedResult = leftTranscript.getByRole('button', { name: /Check result ·/ });
    await expect(linkedResult).toHaveAttribute('aria-current', 'true');
    await expect(linkedResult).toBeFocused();
    await page.keyboard.press('F6');
    await expect(inspector.getByRole('heading', { name: 'Event inspector' })).toBeFocused();
    await focusInspectorAction(page, inspector, page.getByRole('button', { name: /Go to linked event/ }));
    await page.keyboard.press('Enter');
    await expect(inspector).toContainText('Run check');
    await expect(eventTree.getByRole('button', { name: /Run check/ })).toHaveAttribute('aria-current', 'true');
    await expect(page.getByText('No activity')).toHaveCount(0);
    const rightRootEvent = rightTranscript.locator('[data-replay-event="b:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000001:2"]');
    const delegatedEvent = eventTree.getByRole('button', { name: /Delegated parallel work/ });
    await page.getByRole('searchbox', { name: 'Search recorded events' }).fill('delegate');
    await rightRootEvent.click();
    await expect(rightRootEvent).toHaveAttribute('aria-current', 'true');
    await rightTranscript.evaluate(node => { node.scrollTop = node.scrollHeight; });
    const savedRightScroll = await rightTranscript.evaluate(node => node.scrollTop);
    await delegatedEvent.click();
    await inspector.getByText(/Show full recorded content/).click();
    await inspector.getByText('Source and event details').click();
    await expect(inspector.getByText(/Source fingerprint/)).toBeVisible();
    await leftTranscript.evaluate(node => { node.scrollTop = 137; });
    const childAction = inspector.getByRole('button', { name: 'Open delegated session 00000000-0000-4000-8000-000000000002', exact: true });
    await focusInspectorAction(page, inspector, childAction);
    const savedInspectorScroll = await inspector.locator('.replay-inspector-content').evaluate(node => node.scrollTop);
    expect(savedInspectorScroll).toBeGreaterThan(0);
    await expect(inspector).toContainText('Native child history unavailable.');
    await expect(inspector.getByRole('button', { name: 'Open delegated session 00000000-0000-4000-8000-000000000004', exact: true })).toHaveCount(0);
    await expect(inspector.getByRole('button', { name: 'Open delegated session 00000000-0000-4000-8000-000000000003', exact: true })).toHaveCount(0);
    const savedLeftScroll = await leftTranscript.evaluate(node => node.scrollTop);
    await expect.poll(() => leftTranscript.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    await expect.poll(() => rightTranscript.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('searchbox', { name: 'Search recorded events' })).toHaveValue('delegate');
    await expect(eventTree.locator('[data-replay-event="a:00000000-0000-4000-8000-000000000002:00000000-0000-4000-8000-000000000002:1"]')).toHaveAttribute('aria-current', 'true');
    await expect(rightTranscript.locator('[data-replay-event="b:00000000-0000-4000-8000-000000000002:00000000-0000-4000-8000-000000000002:1"][aria-current="true"]')).toHaveCount(0);
    await expect(inspector).toContainText('Worker one result');
    await expect(rightTranscript.locator('[data-slot="message"]')).toHaveCount(32);
    await expect.poll(() => rightTranscript.evaluate(node => node.scrollTop)).toBe(savedRightScroll);
    await focusInspectorAction(page, inspector, inspector.getByRole('button', { name: 'Return to calling event', exact: true }));
    await page.keyboard.press('Enter');
    await expect(page.getByRole('searchbox', { name: 'Search recorded events' })).toHaveValue('delegate');
    await expect(delegatedEvent).toHaveAttribute('aria-current', 'true');
    await expect(inspector).toContainText('Delegated parallel work');
    await expect(inspector.getByText(/Source fingerprint/)).toBeVisible();
    await expect(inspector.locator('details').first()).toHaveAttribute('open', '');
    await expect.poll(() => inspector.locator('.replay-inspector-content').evaluate(node => node.scrollTop)).toBe(savedInspectorScroll);
    await expect.poll(() => leftTranscript.evaluate(node => node.scrollTop)).toBe(savedLeftScroll);
    await expect(rightRootEvent).toHaveAttribute('aria-current', 'true');
    await expect(leftTranscript.getByRole('button', { name: /Worker one result/ })).toHaveCount(0);
    await delegatedEvent.click();
    await page.getByRole('button', { name: 'Open delegated session 00000000-0000-4000-8000-000000000002', exact: true }).click();
    await expect(leftTree.getByRole('button', { name: /Worker one result/ })).toBeFocused();
    await expect(inspector).toContainText('Worker one result');
    // Navigating Right while Left is revealed must retain Left's actor and viewport.
    await leftTranscript.evaluate(node => { node.scrollTop = 213; });
    const revealedLeftScroll = await leftTranscript.evaluate(node => node.scrollTop);
    await rightRootEvent.click();
    await inspector.getByRole('button', { name: 'Open delegated session 00000000-0000-4000-8000-000000000002', exact: true }).click();
    await expect(inspector).toContainText('Right');
    await expect(leftTranscript.getByRole('button', { name: /Worker one result/ })).toHaveAttribute('aria-current', 'true');
    await expect.poll(() => leftTranscript.evaluate(node => node.scrollTop)).toBe(revealedLeftScroll);
    // Return must follow the active side's caller even when the other side
    // delegated more recently and still has its own outstanding return.
    await leftTranscript.getByRole('button', { name: /Worker one result/ }).click();
    await inspector.getByRole('button', { name: 'Return to calling event', exact: true }).click();
    await expect(inspector).toContainText('Left');
    await expect(inspector).toContainText('Delegated parallel work');
    await expect(rightTranscript.getByRole('button', { name: /Worker one result/ })).toHaveAttribute('aria-current', 'true');
    await delegatedEvent.click();
    await inspector.getByRole('button', { name: 'Open delegated session 00000000-0000-4000-8000-000000000002', exact: true }).click();
    await expect(leftTree.getByRole('button', { name: /Worker one result/ })).toBeFocused();
    await leftTranscript.evaluate((node, top) => { node.scrollTop = top; }, revealedLeftScroll);
    await rightTranscript.getByRole('button', { name: /Worker one result/ }).click();
    await inspector.getByRole('button', { name: 'Return to calling event', exact: true }).click();
    await expect(inspector).toContainText('Right');
    await expect(inspector).toContainText('Delegated parallel work');
    await expect.poll(() => leftTranscript.evaluate(node => node.scrollTop)).toBe(revealedLeftScroll);
    await expect(leftTranscript.getByRole('button', { name: /Worker one result/ })).toHaveAttribute('aria-current', 'true');
    await leftTree.getByRole('button', { name: /Delegate nested worker/ }).click();
    await page.getByRole('button', { name: 'Open delegated session 00000000-0000-4000-8000-000000000003', exact: true }).click();
    await expect(inspector).toContainText('Worker two result');
    await page.getByRole('button', { name: 'Return to calling event', exact: true }).click();
    await expect(inspector).toContainText('Delegate nested worker');
    await page.getByRole('button', { name: 'Return to calling event', exact: true }).click();
    await expect(inspector).toContainText('Delegated parallel work');
    await expect(rightTranscript.locator('[data-slot="message"]')).toHaveCount(32);
    await page.getByRole('searchbox', { name: 'Search recorded events' }).fill('Private block omitted');
    await leftTree.getByRole('button', { name: /Private block omitted/ }).click();
    await expect(inspector).toContainText('Some recorded content was omitted for privacy; hidden content is not available in this replay.');
    await expect(inspector.locator('pre')).toHaveCount(0);
    await page.getByRole('searchbox', { name: 'Search recorded events' }).fill('');

    // Switch sides while the sheet remains open, with each transcript keeping
    // its own scroll state.
    const leftScrollAfterBrowse = await leftScroller.evaluate(node => node.scrollTop);
    await rightTranscript.getByRole('button', { name: /User message ·/ }).first().click();
    await expect(inspector).toContainText('Right');
    await expect(inspector).toBeInViewport();
    await expect.poll(() => leftScroller.evaluate(node => node.scrollTop)).toBe(leftScrollAfterBrowse);

    // Escape and the close button both return focus to the browsing event;
    // that focus updates selection without reopening the inspector.
    await delegatedEvent.click();
    await expect(inspector).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(inspector).toHaveCount(0);
    await expect(delegatedEvent).toBeFocused();
    await expect(inspector).toHaveCount(0);
    await page.keyboard.press('F6');
    await expect(inspector.getByRole('heading', { name: 'Event inspector' })).toBeFocused();
    await page.keyboard.press('F6');
    await expect(delegatedEvent).toBeFocused();
    await expect(inspector).toBeVisible();
    await delegatedEvent.click();
    await expect(inspector).toBeVisible();
    await inspector.getByRole('button', { name: /close/i }).click();
    await expect(inspector).toHaveCount(0);
    await expect(delegatedEvent).toBeFocused();
    await expect(inspector).toHaveCount(0);
    await page.evaluate(() => {
      const original = window.requestAnimationFrame.bind(window);
      window.__replayRafControl = { restore: () => { window.requestAnimationFrame = original; } };
      window.requestAnimationFrame = () => 1;
    });
    try {
      await page.keyboard.press('F6');
      await expect(inspector.getByRole('heading', { name: 'Event inspector' })).toBeFocused();
    } finally {
      await page.evaluate(() => window.__replayRafControl.restore());
    }
    await page.keyboard.press('F6');
    await expect(delegatedEvent).toBeFocused();
    await expect(inspector).toBeVisible();

    await delegatedEvent.click();
    await expect(inspector).toBeInViewport();
    await page.screenshot({ path: test.info().outputPath('replay-chat.png'), fullPage: true });
  } finally {
    await page.close();
    await server.close();
  }
});

test('unavailable root histories retain their reason even without any events', async ({ browser }) => {
  const provider = createDemoProvider();
  const server = await startUiServer({ provider, staticRoot: resolve('dist/ui') });
  const page = await browser.newPage();
  try {
    await page.route('**/api/reports/demo-run', async route => {
      const view = await provider.report({ ref: 'demo-run' });
      const missing = replay('left');
      missing.sessions = [{ ...missing.sessions[0], status: 'unavailable', reason: 'Exact native source is missing.', events: [], source: { fingerprint: null } }];
      await route.fulfill({ json: { ...view, replay: { a: missing, b: missing } } });
    });
    await page.goto(server.launchUrl);
    await page.goto(`${server.origin}/reports/demo-run`);
    await expect(page.getByText('Replay coverage', { exact: true })).toBeVisible();
    await expect(page.getByText(/Exact native source is missing/)).toHaveCount(2);
    await expect(page.getByText('No activity recorded in this session.', { exact: true })).toHaveCount(0);
  } finally { await page.close(); await server.close(); }
});

test('replay keeps both sides readable at narrow widths and enlarged text in light and dark themes', async ({ browser }) => {
  const provider = createDemoProvider();
  const server = await startUiServer({ provider, staticRoot: resolve('dist/ui') });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const receiptDir = resolve('test-results/ui-e2e/replay-layout');
  await mkdir(receiptDir, { recursive: true });
  try {
    await page.route('**/api/reports/demo-run', async route => {
      await route.fulfill({ json: { ...await provider.report({ ref: 'demo-run' }),
        replay: { a: replay('left'), b: replay('right') } } });
    });
    await page.goto(server.launchUrl);
    await page.goto(`${server.origin}/reports/demo-run`);
    await expect(page.getByRole('heading', { name: 'Session replay' })).toBeVisible();

    const theme = page.getByRole('combobox', { name: 'Theme' });
    const left = page.getByRole('region', { name: /baseline session tree/i });
    const right = page.getByRole('region', { name: /strict-review session tree/i });
    for (const mode of ['light', 'dark']) {
      await theme.selectOption(mode);
      for (const [width, fontSize] of [[800, '100%'], [800, '200%'], [320, '100%']]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(size => { document.documentElement.style.fontSize = size; }, fontSize);
        await expect(left).toBeVisible();
        await expect(right).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${mode}, ${width}px, text ${fontSize}`).toBe(true);
        await expect(page.getByText('baseline', { exact: true }).first()).toBeVisible();
        await expect(page.getByText('strict-review', { exact: true }).first()).toBeVisible();
        await page.screenshot({ path: resolve(receiptDir, `replay-${mode}-${width}-${fontSize.replace('%', '')}.png`), fullPage: true });
      }
    }
  } finally { await page.close(); await server.close(); }
});

test('real-style delegation is searchable, named and reachable from its assignment', async ({ browser }) => {
  const provider = createDemoProvider();
  const server = await startUiServer({ provider, staticRoot: resolve('dist/ui') });
  const page = await browser.newPage();
  const left = replay('left'), right = replay('right');
  const root = left.sessions[0], worker = left.sessions[1];
  const opaque = `gAAAAA${'A'.repeat(100)}`;
  const call = event(90, root.id, 'spawn_agent', '2026-10-28T12:26:41.000Z', {
    kind: 'tool-call', callId: 'native-spawn', bodyStatus: 'included',
    body: JSON.stringify({ task_name: 'coverage_review', message: opaque }), relatedEventId: `${root.id}:92`,
  });
  root.events.push(call,
    event(91, root.id, 'Delegated agent started started', '2026-10-28T12:26:41.100Z', {
      kind: 'delegation', callId: 'native-spawn', status: 'started', childSessionIds: [worker.id],
    }),
    event(92, root.id, 'Tool result', '2026-10-28T12:26:41.200Z', {
      kind: 'tool-result', callId: 'native-spawn', relatedEventId: call.id,
    }),
    event(93, root.id, 'Uncorroborated assignment', '2026-10-28T12:26:42.000Z', {
      kind: 'tool-call', callId: 'native-spawn', turnId: 'other-turn',
    }));
  // Same call/session IDs on Right must not borrow Left's lifecycle evidence.
  right.sessions[0].events.push(call);
  try {
    await page.route('**/api/reports/demo-run', async route => {
      await route.fulfill({ json: { ...await provider.report({ ref: 'demo-run' }), replay: { a: left, b: right } } });
    });
    await page.goto(server.launchUrl);
    await page.goto(`${server.origin}/reports/demo-run`);
    const leftTree = page.getByRole('region', { name: /baseline session tree/i });
    const rightTree = page.getByRole('region', { name: /strict-review session tree/i });
    const search = page.getByRole('searchbox', { name: 'Search recorded events' });
    await expect(leftTree.getByRole('button', { name: /Worker two result/ })).toBeHidden();
    const firstTurn = leftTree.locator('summary').filter({ hasText: /^Turn 1$/ }).first().locator('..');
    await firstTurn.locator(':scope > summary').press('Enter');
    await expect(firstTurn).not.toHaveAttribute('open');
    await search.fill('Worker two result');
    await expect(leftTree.getByRole('button', { name: /Worker two result/ })).toBeVisible();
    await expect(rightTree.getByRole('button', { name: /Worker two result/ })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'baseline:' })).toContainText('baseline: 1 events match');
    await search.fill('');
    await expect(firstTurn).not.toHaveAttribute('open');
    await firstTurn.locator(':scope > summary').press('Enter');
    await expect(leftTree.getByRole('button', { name: /Worker two result/ })).toBeHidden();
    await leftTree.getByRole('button', { name: /^spawn_agent ·/ }).click();
    const inspector = page.getByRole('dialog', { name: 'Event inspector' });
    await expect(inspector.getByText(/Assignment text is opaque/)).toBeVisible();
    await expect(inspector.getByText(opaque, { exact: false })).toBeHidden();
    const open = inspector.getByRole('button', { name: `Open delegated session ${worker.id}`, exact: true });
    await expect(open).toHaveText('Open coverage_review');
    await open.click();
    await expect(inspector).toContainText('baseline · coverage_review');
    await inspector.getByRole('button', { name: 'Return to calling event', exact: true }).click();
    await expect(leftTree.getByRole('button', { name: /^spawn_agent ·/ })).toBeFocused();
    await inspector.getByRole('button', { name: 'Go to linked event: Tool result', exact: true }).click();
    await expect(open).toBeVisible();
    await leftTree.getByRole('button', { name: /^Uncorroborated assignment ·/ }).click();
    await expect(open).toHaveCount(0);
    await rightTree.getByRole('button', { name: /^spawn_agent ·/ }).click();
    await expect(inspector.getByRole('button', { name: /Open delegated session/ })).toHaveCount(0);
    await inspector.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(leftTree.getByRole('button', { name: /^Delegated agent started ·/ })).toHaveCount(1);
    await expect(page.locator('[aria-label$="event time lane"] button[tabindex="0"]')).toHaveCount(1);
    await page.locator('[aria-label$="event time lane"] button[tabindex="0"]').focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('[data-replay-event][aria-current="true"]:focus')).toHaveCount(1);
    // Dense marker controls remain inside their lanes, including the last timestamp.
    const geometry = await page.locator('[aria-label$="event time lane"]').evaluateAll(lanes => lanes.every(lane => {
      const bounds = lane.getBoundingClientRect();
      return [...lane.querySelectorAll('button')].every(button => {
        const box = button.getBoundingClientRect();
        return box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1
          && box.left >= bounds.left - 1 && box.right <= bounds.right + 1;
      });
    }));
    expect(geometry).toBe(true);
  } finally { await page.close(); await server.close(); }
});

for (const [theme, width] of [['light', 1280], ['dark', 390]]) {
test(`agent summaries link assignment, result and parent follow-up without search or side confusion in ${theme}`, async ({ browser }) => {
  const provider = createDemoProvider();
  const left = replay('left'), right = replay('right');
  for (const [capture, side] of [[left, 'Left'], [right, 'Right']]) {
    const [root, child] = capture.sessions;
    root.cwd = child.cwd = '/captured/workspace';
    const result = `${side} worker produced the navigation changes.`;
    root.events.push(
      event(89, root.id, 'Assistant message', '2026-10-28T12:26:40Z', { kind: 'message', role: 'assistant', bodyStatus: 'included', body: `${side} assignment for worker: implement return navigation.` }),
      event(90, root.id, 'spawn_agent', '2026-10-28T12:26:41Z', { kind: 'tool-call', callId: 'summary-call', bodyStatus: 'included', body: JSON.stringify({ task_name: 'worker', message: 'gAAAAopaque' }) }),
      event(91, root.id, 'Delegated agent started', '2026-10-28T12:26:41Z', { kind: 'delegation', status: 'started', callId: 'summary-call', childSessionIds: [child.id] }),
    );
    child.events.push(
      event(90, child.id, 'Agent update', '2026-10-28T12:26:42Z', { kind: 'message', role: 'assistant', bodyStatus: 'included', body: 'Message Type: NEW_TASK\nTask name: /root/worker\nSender: /root\nPayload:\n' }),
      event(93, child.id, 'Assistant message', '2026-10-28T12:26:43Z', { kind: 'message', role: 'assistant', bodyStatus: 'included', body: `${side} child acknowledges return navigation ownership.` }),
      event(94, child.id, 'File change completed', '2026-10-28T12:26:44Z', { kind: 'file-change', status: 'completed', bodyStatus: 'included', body: JSON.stringify({ changes: { '/captured/workspace/test/navigation.test.js': { type: 'add', content: 'retained test' } } }) }),
      event(91, child.id, 'Assistant message', '2026-10-28T12:26:49Z', { kind: 'message', role: 'assistant', bodyStatus: 'included', body: result }),
      event(92, child.id, 'Session completed', '2026-10-28T12:26:50Z', { kind: 'session', status: 'completed' }),
    );
    if (side === 'Left') root.events.push(
      event(92, root.id, 'Agent update', '2026-10-28T12:26:51Z', { kind: 'message', role: 'assistant', bodyStatus: 'included', body: `Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/worker\nPayload:\n${result}` }),
      event(93, root.id, 'Assistant message', '2026-10-28T12:26:52Z', { kind: 'message', role: 'assistant', bodyStatus: 'included', body: 'I reviewed and integrated /root/worker and corrected its focus handling.' }),
      event(94, root.id, 'Command execution completed', '2026-10-28T12:26:53Z', { kind: 'command', status: 'completed', bodyStatus: 'included', body: JSON.stringify({ command: ['/bin/zsh', '-lc', 'node --test test/navigation.test.js'], output: '5 tests passed', exitCode: 0 }) }),
    );
  }
  const server = await startUiServer({ provider, staticRoot: resolve('dist/ui') });
  const page = await browser.newPage();
  try {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem('xenoflux-theme', value), theme);
    await page.route('**/api/reports/demo-run', async route => route.fulfill({ json: { ...await provider.report({ ref: 'demo-run' }), replay: { a: left, b: right } } }));
    await page.goto(server.launchUrl);
    await page.goto(`${server.origin}/reports/demo-run`);
    const search = page.getByRole('searchbox', { name: 'Search recorded events' });
    const leftTree = page.getByRole('region', { name: 'baseline session tree', exact: true });
    const firstTurn = leftTree.locator('summary').filter({ hasText: /^Turn 1$/ }).first().locator('..');
    await firstTurn.locator(':scope > summary').click();
    await expect(firstTurn).not.toHaveAttribute('open');
    await search.fill('no matching event');
    const trigger = page.getByRole('region', { name: 'Left timeline', exact: true }).getByRole('button', { name: 'View worker summary', exact: true });
    await trigger.click();
    const summary = page.getByRole('dialog', { name: 'Agent summary', exact: true });
    await expect(summary).toContainText('Left assignment for worker: implement return navigation.');
    await expect(summary).toContainText('The recorded assignment prompt is opaque');
    await expect(summary).toContainText("Child's task acknowledgement");
    await expect(summary).toContainText('Left child acknowledges return navigation ownership.');
    await expect(summary).toContainText('node --test test/navigation.test.js');
    await expect(summary).toContainText('Recorded whole-command exit code: 0');
    await expect(summary).toContainText('Left worker produced the navigation changes.');
    await expect(summary).toContainText('I reviewed and integrated /root/worker');
    await expect(summary.getByRole('heading', { name: 'Agent summary', exact: true })).toBeFocused();
    await page.keyboard.press('F6');
    await expect(trigger).toBeFocused();
    await expect(summary).toBeVisible();
    await page.keyboard.press('F6');
    await expect(summary.getByRole('heading', { name: 'Agent summary', exact: true })).toBeFocused();
    const inspector = page.getByRole('dialog', { name: 'Event inspector', exact: true });
    for (const [link, expected, actor] of [
      ['View assignment event', 'gAAAAopaque', 'Main session'],
      ['View parent assignment statement', 'Left assignment for worker:', 'Main session'],
      ['View child acknowledgement', 'Left child acknowledges', 'worker'],
      ['View result event', 'Left worker produced', 'worker'],
      ['View parent receipt', 'Message Type: FINAL_ANSWER', 'Main session'],
      ['View parent follow-up 1', 'I reviewed and integrated', 'Main session'],
      ['View parent command 1', 'node --test test/navigation.test.js', 'Main session'],
      ['View child file change 1', '/captured/workspace/test/navigation.test.js', 'worker'],
    ]) {
      await summary.getByRole('button', { name: link, exact: true }).click();
      await expect(inspector).toContainText(expected);
      await expect(inspector).toContainText(`baseline · ${actor}`);
      await expect(page.locator('[data-replay-side="a"] [aria-current="true"]:focus')).toHaveCount(1);
      if (link === 'View assignment event') {
        await expect(leftTree.getByRole('button', { name: /^spawn_agent ·/ })).toBeFocused();
        await expect(firstTurn).toHaveAttribute('open', '');
      }
      await expect(search).toHaveValue('no matching event');
      await expect(page.getByRole('region', { name: 'strict-review session tree', exact: true }).locator('[data-replay-event]')).toHaveCount(0);
      await inspector.getByRole('button', { name: 'Back to worker summary', exact: true }).click();
      await expect(summary).toBeVisible();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await summary.getByRole('heading', { name: 'Agent summary', exact: true }).press('Escape');
    await expect(trigger).toBeFocused();
    await page.getByRole('region', { name: 'Right timeline', exact: true }).getByRole('button', { name: 'View worker summary', exact: true }).click();
    await expect(summary).toContainText('Right worker produced');
    await expect(summary.getByRole('button', { name: 'View parent receipt', exact: true })).toHaveCount(0);
    await expect(summary.getByRole('button', { name: 'View parent follow-up 1', exact: true })).toHaveCount(0);
    await expect(summary.getByRole('button', { name: 'View parent command 1', exact: true })).toHaveCount(0);
    await expect(summary).toContainText('No unique exact parent delivery');
  } finally { await page.close(); await server.close(); }
});
}

test('comparison reconciles task outcomes, scoped measurements and recorded closing responses', async ({ browser }) => {
  const provider = createDemoProvider();
  const left = replay('left'), right = replay('right');
  const leftRoot = left.sessions[0], rightRoot = right.sessions[0];
  const longResponse = `Left root recorded its final response after completing the task. ${'This retained answer is longer than the summary excerpt. '.repeat(12)} Full response ending marker.`;
  const leftResponse = event(90, leftRoot.id, 'Assistant message', '2026-10-28T12:27:40.000Z', {
    kind: 'message', role: 'assistant', bodyStatus: 'included', body: longResponse,
  });
  leftRoot.events.push(leftResponse,
    event(91, leftRoot.id, 'Session completed', '2026-10-28T12:27:41.000Z', { kind: 'session', status: 'completed' }));
  // An unreadable last response must not fall back to an earlier visible message.
  rightRoot.events.push(
    event(90, rightRoot.id, 'Assistant message', '2026-10-28T12:27:40.000Z', {
      kind: 'message', role: 'assistant', bodyStatus: 'included', body: 'Earlier commentary must not be shown as the closing response.',
    }),
    event(91, rightRoot.id, 'Assistant message', '2026-10-28T12:27:41.000Z', {
      kind: 'message', role: 'assistant', bodyStatus: 'unavailable', bodyReason: 'The response body was not retained.',
    }),
    event(92, rightRoot.id, 'Session completed', '2026-10-28T12:27:42.000Z', { kind: 'session', status: 'completed' }),
  );
  let rightWorkflowValidated = false;
  const server = await startUiServer({ provider, staticRoot: resolve('dist/ui') });
  const page = await browser.newPage();
  try {
    await page.route('**/api/reports/demo-run', async route => {
      const view = await provider.report({ ref: 'demo-run' });
      await route.fulfill({ json: {
        ...view,
        replay: { a: left, b: right },
        agentMeasurements: {
          a: [{ id: leftRoot.id, parentId: null, name: 'Main session', role: 'root', durationMs: 60000,
            timingNote: 'Root replay event timestamps.', counters: { input: 0, cachedInput: 0, output: 3, reasoning: 0, total: 3 },
            usageNote: 'Source-reported per-session counters; not a validated workflow contribution.' },
          { id: left.sessions[1].id, parentId: leftRoot.id, name: 'Implementation worker', role: 'child', durationMs: 20000,
            timingNote: 'First to last recorded replay event.', counters: { input: null, cachedInput: null, output: null, reasoning: null, total: null },
            usageNote: 'Token usage was not recorded for this session.' }],
          b: [{ id: rightRoot.id, parentId: null, name: 'Main session', role: 'root', durationMs: null,
            timingNote: 'Timestamp unavailable.', counters: { input: 1, cachedInput: 0, output: 2, reasoning: 1, total: 3 },
            usageNote: 'Source-reported per-session counters; not a validated workflow contribution.' }],
        },
        workflowMeasurements: {
          a: { durationMs: 120000, timingNote: 'Captured session span.', counters: { input: 4, cachedInput: 1, output: 2, reasoning: 1, total: 6 },
            usageStatus: 'partial', usageNote: 'Captured workflow session counters.', coverageNote: 'Captured 2 of 4 sessions.', runnerDurationMs: 150000 },
          b: { durationMs: 45000, timingNote: 'Workflow span from captured events.', counters: { input: 80, cachedInput: 20, output: 40, reasoning: 10, total: 120 },
            usageStatus: rightWorkflowValidated ? 'validated' : 'unvalidated',
            usageNote: rightWorkflowValidated ? 'Validated from independently owned session usage.' : 'This numeric snapshot is not a validated workflow total.',
            coverageNote: 'Complete workflow ownership is not established.', runnerDurationMs: null },
        },
        attempt: { ...(view.attempt ?? {}), title: 'Both model tasks completed', notStarted: false,
          cells: view.verification.cells.map(cell => ({ side: cell.side, profile: cell.profile, state: 'completed', text: 'Model task completed', detail: '' })) },
        verification: { ...view.verification, none: false,
          rows: [
            { id: 'typescript-check', name: 'TypeScript', definitionMatch: 'same',
              a: inspectedCheck('typescript-left', 'TypeScript', 'passed'),
              b: inspectedCheck('typescript-right', 'TypeScript', 'passed') },
            { id: 'browser-check', name: 'Replay browser acceptance', definitionMatch: 'different',
              a: inspectedCheck('browser-left', 'Replay browser acceptance', 'passed'),
              b: inspectedCheck('browser-right', 'Replay browser acceptance', 'failed') },
          ], cells: view.verification.cells.map((cell, index) => ({
          ...cell, claim: 'No structured success assessment was recorded.', checks: index === 0
            ? [{ status: 'success', text: 'Your check (TypeScript) passed' }]
            : [{ status: 'success', text: 'Your check (TypeScript) passed' }, { status: 'error', text: 'Your check (Replay browser acceptance) failed' }],
        })) },
        conditions: { ...view.conditions, scopeNote: 'These model and effort values describe recorded turns; child settings may be unknown.' },
        timeTokens: { ...view.timeTokens, rows: [
          { name: 'Recorded time span', a: '1 min 0 s', b: 'Not recorded', scope: { a: 'Root replay event timestamps', b: 'Timestamp unavailable' }, caveat: 'First to last event, not active work.' },
          { name: 'Total for the whole workflow', a: 'Not validated', b: 'Not validated', scope: { a: 'Captured workflow agents', b: 'Captured workflow agents' }, caveat: 'Source-reported cumulative agent snapshots are not summed into a workflow total.' },
        ] },
        outcome: { ...view.outcome, scopeNote: 'Counts and paths come from one complete task-end inventory.' },
      } });
    });
    await page.goto(server.launchUrl);
    await page.goto(`${server.origin}/reports/demo-run`);

    const outcomes = page.locator('[aria-label$="task outcome"]');
    await expect(outcomes).toHaveCount(2);
    const assessment = page.getByRole('heading', { name: 'Assessment', exact: true });
    await expect(assessment).toBeVisible();
    const checks = page.getByRole('table', { name: 'Recorded checks assessment' });
    await expect(checks.locator('tbody tr')).toHaveCount(2);
    await expect(checks.getByText('Same check definition')).toBeVisible();
    await expect(checks.getByText('Different check definitions')).toBeVisible();
    await expect(checks.getByRole('button', { name: 'Inspect baseline result for TypeScript' })).toBeVisible();
    await expect(checks.getByRole('button', { name: 'Inspect strict-review result for Replay browser acceptance' })).toBeVisible();

    const replayHeading = page.getByRole('heading', { name: 'Session replay', exact: true });
    const order = await page.evaluate(() => {
      const outcome = document.querySelector('[aria-label$="task outcome"]');
      const replayHeading = [...document.querySelectorAll('h2')].find(node => node.textContent?.trim() === 'Session replay');
      return Boolean(outcome && replayHeading && outcome.compareDocumentPosition(replayHeading) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(order).toBe(true);
    await expect(replayHeading).toBeVisible();

    await expect(page.getByText('Every bar uses the same scale.', { exact: false })).toBeVisible();
    await expect(page.getByText('A partial workflow bar covers captured sessions only; missing sessions remain unknown.', { exact: true })).toBeVisible();
    await expect(page.getByText('These model and effort values describe recorded turns; child settings may be unknown.', { exact: true })).toBeVisible();
    await expect(page.getByText('Counts and paths come from one complete task-end inventory.', { exact: true })).toBeVisible();

    const rightTree = page.getByRole('region', { name: 'strict-review session tree', exact: true });
    await rightTree.getByRole('button', { name: /User message ·/ }).first().click();
    await page.keyboard.press('Escape');
    const rightSelection = rightTree.locator('[data-replay-event][aria-current="true"]');
    await expect(rightSelection).toHaveCount(1);
    const rightSelectedId = await rightSelection.getAttribute('data-replay-event');
    const search = page.getByRole('searchbox', { name: 'Search recorded events' });
    await search.fill('no matching recorded event');
    const responses = page.getByRole('heading', { name: 'Last recorded response', exact: true });
    await expect(responses).toBeVisible();
    const leftResponseRegion = page.locator('[aria-label="baseline last recorded response"]');
    const rightResponseRegion = page.locator('[aria-label="strict-review last recorded response"]');
    await expect(leftResponseRegion).toBeVisible();
    await expect(leftResponseRegion).toContainText('Last recorded assistant response before completion');
    await expect(leftResponseRegion.locator('pre').first()).toHaveText(longResponse);
    const responsePreview = leftResponseRegion.locator('[class*=\"max-h-64\"]').first();
    await expect.poll(() => responsePreview.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
    await expect(rightResponseRegion).toContainText('The last recorded assistant response is unreadable');
    await expect(rightResponseRegion).not.toContainText('Earlier commentary must not be shown');
    await leftResponseRegion.getByRole('button', { name: 'Read full response', exact: true }).click();
    await expect(leftResponseRegion.getByRole('button', { name: 'Hide full response', exact: true })).toBeVisible();
    await expect(leftResponseRegion.locator('pre').last()).toHaveText(longResponse);

    const timeSection = page.locator('section[aria-labelledby="time"]');
    const legend = timeSection.getByRole('list', { name: 'Token bar legend', exact: true });
    await expect(legend.getByRole('listitem')).toHaveText(['Uncached input', 'Cached input', 'Other output', 'Reasoning']);
    await expect(legend).toHaveCount(1);
    const leftMeasurements = timeSection.locator('[aria-label="baseline time and tokens"]');
    const rightMeasurements = timeSection.locator('[aria-label="strict-review time and tokens"]');
    const leftRows = leftMeasurements.locator('details.measurement-row');
    const rightRows = rightMeasurements.locator('details.measurement-row');
    await expect(leftRows).toHaveCount(3);
    await expect(rightRows).toHaveCount(2);
    await expect(leftRows.nth(0).locator('summary')).toContainText('Workflow');
    await expect(leftRows.nth(1).locator('summary')).toContainText('Main session');
    await expect(leftRows.nth(2).locator('summary')).toContainText('Delegated by Main session');
    await expect(leftRows.nth(0).locator('summary')).toContainText('6 captured tokens');
    await expect(leftRows.nth(0).locator('summary')).toContainText('Whole workflow not validated');
    await expect(leftRows.nth(0)).toContainText('Captured 2 of 4 sessions.');
    await expect(leftRows.nth(2).locator('summary')).toContainText('Token mix not recorded');
    const unvalidatedWorkflow = rightRows.nth(0);
    await expect(unvalidatedWorkflow.locator('.measurement-total')).toHaveText('Not validated');
    await expect(unvalidatedWorkflow.getByRole('img')).toHaveCount(0);
    await expect(unvalidatedWorkflow.locator('summary')).not.toContainText('120');
    await expect(rightRows.nth(1).locator('.measurement-time')).toHaveText('Not recorded');
    await rightRows.nth(1).locator('summary').click();
    await expect(rightRows.nth(1)).toContainText('Timestamp unavailable.');

    const workflowBar = leftRows.nth(0).getByRole('img', { name: /Captured workflow sessions only: 6 tokens/ });
    const leftMainBar = leftRows.nth(1).getByRole('img', { name: /Main session: 3 tokens/ });
    const rightMainBar = rightRows.nth(1).getByRole('img', { name: /Main session: 3 tokens/ });
    await expect(workflowBar).toBeVisible();
    await expect(leftMainBar).toBeVisible();
    await expect(rightMainBar).toBeVisible();
    const fillWidth = async bar => bar.locator('.measurement-bar-fill').evaluate(node => {
      const track = node.parentElement;
      return { width: parseFloat(node.style.width), clipped: node.getBoundingClientRect().right > track.getBoundingClientRect().right + 1 };
    });
    expect(await fillWidth(workflowBar)).toEqual({ width: 100, clipped: false });
    expect(await fillWidth(leftMainBar)).toEqual({ width: 50, clipped: false });
    expect(await fillWidth(rightMainBar)).toEqual({ width: 50, clipped: false });

    await leftRows.nth(0).locator('summary').click();
    const workflowDetails = leftRows.nth(0);
    await expect(workflowDetails.getByText('Input tokens', { exact: true }).locator('xpath=following-sibling::dd[1]')).toHaveText('4');
    await expect(workflowDetails.getByText('Cached input (included in input)', { exact: true }).locator('xpath=following-sibling::dd[1]')).toHaveText('1');
    await expect(workflowDetails.getByText('Output tokens', { exact: true }).locator('xpath=following-sibling::dd[1]')).toHaveText('2');
    await expect(workflowDetails.getByText('Reasoning (included in output)', { exact: true }).locator('xpath=following-sibling::dd[1]')).toHaveText('1');
    await expect(workflowDetails.getByText('Total tokens', { exact: true }).locator('xpath=following-sibling::dd[1]')).toHaveText('6');

    await leftRows.nth(1).locator('summary').click();
    const mainDetails = leftRows.nth(1);
    await expect(mainDetails).toContainText('Root replay event timestamps.');
    await expect(mainDetails.getByText('Input tokens', { exact: true }).locator('xpath=following-sibling::dd[1]')).toHaveText('0');
    await expect(mainDetails.getByText('Cached input (included in input)', { exact: true }).locator('xpath=following-sibling::dd[1]')).toHaveText('0');
    await expect(mainDetails.getByText('Output tokens', { exact: true }).locator('xpath=following-sibling::dd[1]')).toHaveText('3');
    await expect(mainDetails.getByText('Reasoning (included in output)', { exact: true }).locator('xpath=following-sibling::dd[1]')).toHaveText('0');
    await expect(mainDetails.getByText('Total tokens', { exact: true }).locator('xpath=following-sibling::dd[1]')).toHaveText('3');

    await leftRows.nth(2).locator('summary').click();
    const childDetails = leftRows.nth(2);
    await expect(childDetails.getByText('Input tokens', { exact: true }).locator('xpath=following-sibling::dd[1]')).toHaveText('Not recorded');
    await expect(childDetails.getByText('Total tokens', { exact: true }).locator('xpath=following-sibling::dd[1]')).toHaveText('Not recorded');

    const responseEventTrigger = leftResponseRegion.getByRole('button', { name: 'Open response event', exact: true });
    await responseEventTrigger.click();
    const inspector = page.getByRole('dialog', { name: 'Event inspector', exact: true });
    await expect(inspector).toContainText('Full response ending marker.');
    const leftResponseEvent = page.locator(`[data-replay-event="a:${leftRoot.id}:${leftResponse.id}"]`);
    await expect(leftResponseEvent).toHaveAttribute('aria-current', 'true');
    await expect(inspector.getByRole('heading', { name: 'Event inspector', exact: true })).toBeFocused();
    await expect(search).toHaveValue('no matching recorded event');
    await expect(rightTree.locator('[data-replay-event]')).toHaveCount(0);
    await inspector.getByRole('button', { name: 'Back to recorded response', exact: true }).click();
    await expect(responseEventTrigger).toBeFocused();
    await expect(search).toHaveValue('no matching recorded event');

    await responseEventTrigger.click();
    await page.keyboard.press('Escape');
    await expect(inspector).toHaveCount(0);
    await expect(responseEventTrigger).toBeFocused();
    await expect(search).toHaveValue('no matching recorded event');
    await page.evaluate(() => {
      const nextFrame = window.requestAnimationFrame.bind(window);
      const pending = [];
      window.requestAnimationFrame = callback => { pending.push(callback); return 0; };
      window.flushReplayFrame = () => new Promise(resolve => {
        window.requestAnimationFrame = nextFrame;
        nextFrame(time => { for (const callback of pending) callback(time); resolve(); });
      });
    });
    await responseEventTrigger.click();
    await expect(inspector).toBeVisible();
    await search.focus();
    await page.evaluate(() => window.flushReplayFrame());
    await expect(search).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(inspector).toHaveCount(0);
    await expect(search).toBeFocused();
    await search.fill('');
    await expect(search).toHaveValue('');
    await expect(rightSelection).toHaveAttribute('data-replay-event', rightSelectedId);

    rightWorkflowValidated = true;
    await page.reload();
    const validatedWorkflow = page.locator('[aria-label="strict-review time and tokens"]').locator('details.measurement-row').first();
    await expect(validatedWorkflow.locator('.measurement-total')).toHaveText('120 tokens');
    await expect(validatedWorkflow.getByRole('img', { name: /Workflow: 120 tokens/ })).toBeVisible();
    await validatedWorkflow.locator('summary').click();
    await expect(validatedWorkflow.getByText('Total tokens', { exact: true }).locator('xpath=following-sibling::dd[1]')).toHaveText('120');
  } finally { await page.close(); await server.close(); }
});
