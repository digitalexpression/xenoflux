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
      ...replay.sessions[0].events[0], id: `dense-${index}`, turnId: `turn-${index}`, timestamp: '2026-11-15T08:00:00Z',
    }));
    await page.route('**/api/reports/demo-run', route => route.fulfill({ json: { ...original,
      verification: { ...original.verification, none: false, rows: [] },
      replay: empty ? null : { a: replay, b: retainedReplay('right') },
    } }));
    await page.goto(server.launchUrl);
    await page.goto(`${server.origin}/reports/demo-run`);
    const lines = page.getByRole('region', { name: 'Recorded activity', exact: true });
    const track = lines.getByRole('group', { name: 'baseline · Main session recorded stops', exact: true });
    await expect(track.getByRole('button')).toHaveCount(20);
    const boxes = await track.getByRole('button').evaluateAll(nodes => nodes.map(node => {
      const box = node.getBoundingClientRect(); return { x: box.x, right: box.right };
    }));
    expect(boxes.every((box, index) => !index || box.x >= boxes[index - 1].right)).toBe(true);
    await expect(lines.getByText(/first 20 of 25 stops/)).toBeVisible();
    await expect(page.getByRole('group', { name: 'Recorded finding counts' }).locator('.comparison-count strong').last()).toHaveText('Unknown');
    empty = true;
    await page.reload();
    await expect(lines.getByText('No replay retained for this side. Activity cannot be reconstructed.')).toHaveCount(2);
    await expect(lines.getByRole('button')).toHaveCount(0);
  } finally { await page.close(); await server.close(); }
});

for (const [theme, width] of [['light', 1280], ['dark', 1440]]) {
  test(`Counts lead report preserves source links and explicit unknowns in ${theme}`, async ({ browser }, testInfo) => {
    const provider = createDemoProvider();
    const server = await startUiServer({ provider, staticRoot: resolve('dist/ui') });
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const original = await provider.report({ ref: 'demo-run' });
      await page.route('**/api/reports/demo-run', route => route.fulfill({ json: {
        ...original, replay: { a: retainedReplay('left'), b: retainedReplay('right') },
      } }));
      await page.goto(server.launchUrl);
      await page.goto(`${server.origin}/reports/demo-run`);
      await page.getByRole('combobox', { name: 'Theme' }).selectOption(theme);
      const counts = page.getByRole('group', { name: 'Recorded finding counts' });
      await expect(counts.locator('.comparison-count strong')).toHaveText([
        String(original.counts.different), String(original.counts.same), String(original.counts.cannotCompare), '0',
      ]);
      const lines = page.getByRole('region', { name: 'Recorded activity', exact: true });
      await expect(lines.getByText(/Turn token|Hollow stops/)).toBeVisible();
      await expect(lines.locator('.comparison-branch[data-linked="true"]')).toHaveCount(2);
      await expect(lines.locator('.comparison-stop-track[data-ordered="true"]')).toHaveCount(1);
      await expect(lines.locator('.comparison-stop-track[data-ordered="false"]')).toHaveCount(1);
      const [countBox, lineBox, conditionBox] = await Promise.all([
        counts.boundingBox(), lines.boundingBox(), page.locator('.comparison-conditions').boundingBox(),
      ]);
      expect(countBox.y + countBox.height).toBeLessThanOrEqual(lineBox.y);
      expect(lineBox.y + lineBox.height).toBeLessThanOrEqual(conditionBox.y);
      const firstCondition = await page.getByRole('table', { name: 'Recorded conditions comparison' }).getByRole('row').nth(1).boundingBox();
      expect(firstCondition.y + firstCondition.height).toBeLessThanOrEqual(900);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`report-${theme}-${width}.png`), animations: 'disabled' });
      await page.locator('.comparison-conditions').scrollIntoViewIfNeeded();
      await expect(page.getByRole('table', { name: 'Recorded conditions comparison' }).getByRole('columnheader', { name: 'Recorded result' })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`report-conditions-${theme}-${width}.png`), animations: 'disabled' });
      const stop = lines.getByRole('button', { name: /baseline · Main session · Turn 1/ });
      await stop.focus();
      await page.keyboard.press('Enter');
      const inspector = page.getByRole('dialog', { name: 'Event inspector' });
      await expect(inspector.getByRole('heading', { name: 'Event inspector' })).toBeFocused();
      await expect(inspector.getByText('left retained task', { exact: true })).toBeVisible();
      await expect(inspector.getByText('Time not recorded', { exact: false }).first()).toBeVisible();
      const rightConversation = await page.getByRole('region', { name: 'strict-review session tree', exact: true }).boundingBox();
      const inspectorBox = await inspector.boundingBox();
      expect(rightConversation.x + rightConversation.width).toBeLessThanOrEqual(inspectorBox.x);
      await page.keyboard.press('Escape');
      await expect(inspector).toHaveCount(0);
      await expect(stop).toBeFocused();
    } finally { await page.close(); await server.close(); }
  });
}
