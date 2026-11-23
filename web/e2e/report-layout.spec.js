import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { createDemoProvider } from '../../src/ui-demo.js';
import { startUiServer } from '../../src/ui-server.js';

function retainedReplay(side) {
  const root = `${side}-root`, child = `${side}-child`;
  const event = (id, sessionId, turnId, timestamp, body) => ({ id, sessionId, turnId, timestamp,
    kind: 'message', role: 'user', label: 'User message', sourceLine: 1, body, bodyStatus: 'included' });
  return { schemaVersion: 1, kind: 'session-replay', sessions: [
    { id: root, parentId: null, status: 'partial', source: { fingerprint: null }, events: [
      event('first', root, 'turn-one', side === 'right' ? '2026-11-15T08:00:00Z' : null, `${side} retained task`),
      event('second', root, 'turn-two', '2026-11-15T08:01:00Z', 'Later recorded task'),
    ] },
    { id: child, parentId: root, status: 'partial', source: { fingerprint: null }, events: [
      event('child-first', child, 'child-turn', '2026-11-15T08:00:30Z', `${side} delegated task`),
    ] },
  ] };
}

test('crowded stops stay separately reachable and absent replay keeps unavailable check counts unknown', async ({ browser }) => {
  const provider = createDemoProvider();
  const server = await startUiServer({ provider, staticRoot: resolve('dist/ui') });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  let empty = false;
  try {
    const original = await provider.report({ ref: 'demo-run' });
    const replay = retainedReplay('left');
    replay.sessions[0].events = Array.from({ length: 25 }, (_, index) => ({
      ...replay.sessions[0].events[0], id: `dense-${index}`, turnId: `turn-${index}`, timestamp: null,
    }));
    await page.route('**/api/reports/demo-run', route => route.fulfill({ json: { ...original,
      verification: { ...original.verification, none: false, rows: [] },
      replay: empty ? null : { a: replay, b: retainedReplay('right') },
    } }));
    await page.goto(server.launchUrl);
    await page.goto(`${server.origin}/reports/demo-run`);
    const tabs = page.getByRole('navigation', { name: 'Report views' });
    await tabs.getByRole('link', { name: 'Session replay' }).click();
    const track = page.getByRole('region', { name: 'Left timeline' }).getByRole('group', { name: 'Root session left-root event order lane' });
    await expect(track.getByRole('button')).toHaveCount(25);
    const boxes = await track.getByRole('button').evaluateAll(nodes => nodes.map(node => {
      const box = node.getBoundingClientRect(); return { x: box.x, right: box.right };
    }));
    expect(boxes.every((box, index) => !index || box.x >= boxes[index - 1].right)).toBe(true);
    await tabs.getByRole('link', { name: 'Grouped evidence' }).click();
    await page.getByRole('button', { name: 'Show analytical finding counts' }).click();
    await expect(page.getByRole('group', { name: 'Recorded finding counts' }).locator('.comparison-count strong').last()).toHaveText('Unknown');
    await tabs.getByRole('link', { name: 'Session replay' }).click();
    empty = true;
    await page.reload();
    await expect(page.getByText('Session replay unavailable')).toBeVisible();
    await expect(track).toHaveCount(0);
  } finally { await page.close(); await server.close(); }
});

for (const [theme, width] of [['light', 1280], ['dark', 1440]]) {
  test(`Run facts lead the report and activity keeps source links in ${theme}`, async ({ browser }, testInfo) => {
    const provider = createDemoProvider();
    const server = await startUiServer({ provider, staticRoot: resolve('dist/ui') });
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const original = await provider.report({ ref: 'demo-run' });
      await page.route('**/api/reports/demo-run', route => route.fulfill({ json: {
        ...original, replay: { a: retainedReplay('left'), b: retainedReplay('right') },
        overview: [{ name: 'Task and capture time', a: '13 s', b: '5 s' }, { name: 'Tool calls', a: '1', b: '1 retained' }],
      } }));
      await page.goto(server.launchUrl);
      await page.goto(`${server.origin}/reports/demo-run`);
      await page.getByRole('combobox', { name: 'Theme' }).selectOption(theme);
      const facts = page.getByRole('table', { name: 'Run facts comparison' });
      await expect(facts.getByRole('row', { name: /Tool calls/ })).toContainText('1 retained');
      const counts = page.getByRole('group', { name: 'Recorded finding counts' });
      await expect(counts).toBeHidden();
      await page.getByRole('button', { name: 'Show analytical finding counts' }).click();
      await expect(counts.locator('.comparison-count strong')).toHaveText([
        String(original.counts.different), String(original.counts.same), String(original.counts.cannotCompare), '0',
      ]);
      await page.getByRole('button', { name: 'Hide analytical finding counts' }).click();
      const factsBox = await facts.boundingBox();
      expect(factsBox.y + factsBox.height).toBeLessThanOrEqual(900);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`report-${theme}-${width}.png`), animations: 'disabled' });
      await page.locator('summary').filter({ hasText: 'Conditions and coverage' }).click();
      await expect(page.getByRole('table', { name: 'Recorded conditions comparison' }).getByRole('columnheader', { name: 'Recorded result' })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`report-conditions-${theme}-${width}.png`), animations: 'disabled' });
      await page.getByRole('navigation', { name: 'Report views' }).getByRole('link', { name: 'Session replay' }).click();
      const leftLane = page.getByRole('region', { name: 'Left timeline' });
      const rightLane = page.getByRole('region', { name: 'Right timeline' });
      const [leftBox, rightBox] = await Promise.all([leftLane.boundingBox(), rightLane.boundingBox()]);
      expect(leftBox.y + leftBox.height).toBeLessThanOrEqual(rightBox.y);
      await expect(leftLane.getByRole('group', { name: 'Child session left-child event time lane' })).toBeVisible();
      const citation = JSON.stringify(['a', 'left-root', 'first']);
      await page.goto(`${server.origin}/reports/demo-run?event=${encodeURIComponent(citation)}`);
      const inspector = page.getByRole('dialog', { name: 'Event inspector' });
      await expect(inspector.getByRole('heading', { name: 'Event inspector' })).toBeFocused();
      await expect(inspector.getByText('left retained task', { exact: true })).toBeVisible();
      expect(new URL(page.url()).searchParams.get('event')).toBe(citation);
      await expect(inspector.getByText('Time not recorded', { exact: false }).first()).toBeVisible();
      const rightConversation = await page.getByRole('region', { name: 'strict-review session tree', exact: true }).boundingBox();
      const inspectorBox = await inspector.boundingBox();
      expect(rightConversation.x + rightConversation.width).toBeLessThanOrEqual(inspectorBox.x);
      await page.keyboard.press('Escape');
      await expect(inspector).toHaveCount(0);
      await expect(page.getByRole('navigation', { name: 'Report views' }).getByRole('link', { name: 'Session replay' })).toHaveAttribute('aria-current', 'page');
    } finally { await page.close(); await server.close(); }
  });
}
