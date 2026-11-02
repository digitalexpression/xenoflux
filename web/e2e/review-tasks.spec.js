import { readFile, rm } from 'node:fs/promises';
import { test as base, expect } from '@playwright/test';
import { buildAuditReviewPacket } from '../../src/audit-review.js';
import { createUiReviewBrowserFixture } from '../../test-support/ui-review-browser-fixture.js';

const test = base.extend({
  app: async ({}, use, testInfo) => {
    const mode = testInfo.title.includes('cancels while waiting') ? 'cancel'
      : testInfo.title.includes('Start response is delayed') ? 'lost-start-response'
        : testInfo.title.includes('active task rejects') ? 'admission'
      : testInfo.title.includes('unsupported native request') ? 'unsupported' : 'complete';
    const app = await createUiReviewBrowserFixture({ mode });
    try { await use(app); }
    finally {
      if (testInfo.status !== testInfo.expectedStatus && app.serverLogs.length) {
        await testInfo.attach('ui-server.log', { body: app.serverLogs.join('\n'), contentType: 'text/plain' });
      }
      app.releaseStartResponse?.();
      await app.close();
    }
  },
});

async function openReview(page, app) {
  await page.goto(app.url);
  await expect(page.getByRole('heading', { name: 'What do you want to compare?', level: 1 })).toBeVisible();
  await page.goto(`${app.origin}/reports/${app.ref}`);
  await page.getByRole('link', { name: 'Review', exact: true }).click();
  await expect(page).toHaveURL(/\/reviews\?new=1/);
  await expect(page.getByRole('heading', { name: 'Reviews', level: 1 })).toBeVisible();
}

async function prepare(page) {
  await page.getByLabel('Profile').selectOption({ label: 'baseline' });
  await page.getByLabel('Review prompt').fill('Review the frozen comparison and explain one tradeoff.');
  await page.getByRole('button', { name: 'Preview review' }).click();
  await expect(page.getByRole('region', { name: 'Review task preview' })).toBeVisible();
}

test('runs one native review, answers its approval, and reopens frozen response after source loss and server restart', async ({ app, page }, testInfo) => {
  test.setTimeout(60000);
  await openReview(page, app);
  await prepare(page);
  await expect(page.getByRole('region', { name: 'Review task preview' })).toContainText('report.md');
  await expect(page.getByRole('region', { name: 'Review task preview' })).toContainText(app.repository);
  await page.getByRole('button', { name: 'Start review' }).click();

  await expect(page.getByRole('region', { name: 'Native request' })).toBeVisible({ timeout: 20000 });
  const request = page.getByRole('region', { name: 'Native request' });
  await expect(request).toContainText('cat report.md');
  await page.screenshot({ path: testInfo.outputPath('review-native-command-request.png'), fullPage: true });
  await page.reload();
  await expect(page.getByRole('region', { name: 'Native request' })).toBeVisible();
  await page.getByRole('button', { name: 'Allow once' }).click();
  await expect(page.getByRole('region', { name: 'Native request' })).toContainText('Review a changed report citation');
  await expect(page.getByRole('region', { name: 'Native request' })).toContainText('old citation');
  await expect(page.getByRole('region', { name: 'Native request' })).toContainText('new citation');
  await page.screenshot({ path: testInfo.outputPath('review-native-file-change-request.png'), fullPage: true });
  await page.getByRole('button', { name: 'Allow once' }).click();
  await expect(page.getByRole('region', { name: 'Native request' })).toContainText('Allow report lookup');
  await page.getByRole('button', { name: 'Allow for this turn' }).click();
  await expect(page.getByRole('region', { name: 'Native request' })).toContainText('Allow optional network follow-up');
  await page.getByRole('button', { name: 'Decline permissions' }).click();
  const question = page.getByRole('region', { name: 'Native request' });
  await expect(question).toContainText('Should the review include a detailed explanation?');
  const detailChoice = question.getByLabel('Should the review include a detailed explanation?');
  await expect(detailChoice).toHaveValue('');
  await detailChoice.selectOption({ label: 'Yes, include detail' });
  await page.getByRole('button', { name: 'Send answers' }).click();
  await expect(page.getByText(/this is a task-scoped review\./i)).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole('heading', { name: 'Review task', level: 2 })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('review-completed-response.png'), fullPage: true });

  const taskId = new URL(page.url()).searchParams.get('task');
  expect(taskId).toMatch(/^[0-9a-f-]{36}$/);
  const observedPath = `${app.executable}.observed`;
  const observed = JSON.parse(await readFile(observedPath, 'utf8'));
  expect(observed.reportPath).toContain(`/review-tasks/${taskId}/report.md`);
  expect(observed.reportText).toContain('# Audit comparison');
  expect(observed.prompt).toContain(observed.reportPath);
  expect(await readFile(`${app.homes.baseline.home}/config.toml`, 'utf8')).toBe(app.reviewEvidence.originalConfig);
  const nativeResponses = (await readFile(`${app.executable}.responses`, 'utf8')).trim().split('\n').map(JSON.parse);
  expect(nativeResponses.map(row => row.result)).toEqual([
    { decision: 'accept' },
    { decision: 'accept' },
    { permissions: { network: { enabled: true } }, scope: 'turn' },
    { permissions: {}, scope: 'turn' },
    { answers: { 'include-detail': { answers: ['Yes, include detail'] } } },
  ]);

  await page.reload();
  await expect(page.getByText(/this is a task-scoped review\./i)).toBeVisible();
  const restarted = await app.restartServer();
  await rm(`${app.store.directory}/audits`, { recursive: true, force: true });
  await rm(`${app.homes.baseline.home}/sessions`, { recursive: true, force: true });
  await rm(`${app.homes.strict.home}/sessions`, { recursive: true, force: true });
  await page.goto(restarted.url);
  await expect(page.getByRole('heading', { name: 'What do you want to compare?', level: 1 })).toBeVisible();
  await page.goto(`${restarted.origin}/reports/r.${taskId}/reviews?task=${taskId}`);
  await expect(page.getByText(/this is a task-scoped review\./i)).toBeVisible();
  await page.getByRole('link', { name: 'Open its comparison and evidence' }).click();
  await expect(page).toHaveURL(new RegExp(`/reports/r\\.${taskId}$`));
  await expect(page.getByRole('heading', { name: 'Last recorded response' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Session replay' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Compared profiles' })).toContainText('baseline');
  await expect(page.getByRole('group', { name: 'Compared profiles' })).toContainText('strict-review');
  const reportReviews = page.getByRole('link', { name: 'Review', exact: true });
  await expect(reportReviews).toBeVisible();
  await expect(reportReviews).toHaveAttribute('href', `/reports/r.${taskId}/reviews?new=1`);
  const frozenReport = JSON.parse(await readFile(`${app.store.directory}/review-tasks/${taskId}/report.md.audit.json`, 'utf8'));
  const evidenceSubject = frozenReport.subject ?? frozenReport;
  const packet = buildAuditReviewPacket(evidenceSubject);
  const references = packet.evidenceRefs;
  expect(references).toContain(`run:${evidenceSubject.left.id}`);
  expect(references).toContain(`run:${evidenceSubject.right.id}`);
  const replayRef = references.find(reference => reference.startsWith('replay:'));
  expect(replayRef).toBeTruthy();
  const [runId, sessionId, eventId] = JSON.parse(decodeURIComponent(replayRef.slice('replay:'.length)));
  const sourceRun = evidenceSubject.left.id === runId ? evidenceSubject.left : evidenceSubject.right;
  const citedEvent = sourceRun.sessionReplay.sessions.find(session => session.id === sessionId).events.find(event => event.id === eventId);
  expect(citedEvent).toBeTruthy();
  const citedProfile = evidenceSubject.left.id === runId ? 'baseline' : 'strict-review';
  await page.getByRole('button', { name: `${citedProfile}: ${citedEvent.label}` }).click();
  await page.getByText('Source and event details').click();
  await expect(page.getByText(`session ${sessionId} · turn`, { exact: false })).toBeVisible();
  await expect(page.getByText('Event reference:')).toContainText(eventId);
  expect(JSON.parse(await readFile(`${app.executable}.starts`, 'utf8'))).toBe(1);
});

test('cancels while waiting for native approval, retains partial response, and never starts again on refresh', async ({ app, page }) => {
  await openReview(page, app);
  await prepare(page);
  await page.getByRole('button', { name: 'Start review' }).click();
  await expect(page.getByRole('region', { name: 'Native request' })).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: 'Cancel review' }).click();
  await expect(page.getByRole('heading', { name: 'Partial response' })).toBeVisible({ timeout: 20000 });
  await expect(page.getByText('Partial review text retained before the task stopped.')).toBeVisible();
  await expect(page.getByText('Cancelled', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Partial response' })).toBeVisible();
  expect(JSON.parse(await readFile(`${app.executable}.starts`, 'utf8'))).toBe(1);
});

test('unsupported native request fails visibly with retained partial response and no automatic retry', async ({ app, page }) => {
  await openReview(page, app);
  await prepare(page);
  await page.getByRole('button', { name: 'Start review' }).click();
  await expect(page.getByText(/item\/unknown\/requestApproval/)).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole('heading', { name: 'Partial response' })).toBeVisible();
  await expect(page.getByText('Partial review text retained before the task stopped.')).toBeVisible();
  await page.reload();
  await expect(page.getByText(/item\/unknown\/requestApproval/)).toBeVisible();
  expect(JSON.parse(await readFile(`${app.executable}.starts`, 'utf8'))).toBe(1);
});

test('Start response is delayed across reload but the URL task reconnects without a second native execution', async ({ app, page }) => {
  await openReview(page, app);
  await prepare(page);
  await page.getByRole('button', { name: 'Start review' }).click();
  await expect(page).toHaveURL(/\/reports\/e\.[0-9a-f-]+\/reviews\?task=[0-9a-f-]+$/);
  const taskId = new URL(page.url()).searchParams.get('task');
  expect(taskId).toMatch(/^[0-9a-f-]{36}$/);
  await expect(page.getByRole('button', { name: 'Return to review form' })).toBeDisabled();
  await expect.poll(() => app.provider.reviewTask({ id: taskId }).then(task => task.status, () => null),
    { timeout: 20000 }).toBe('waiting-for-user');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Review task', level: 2 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Native request' })).toBeVisible();
  expect(JSON.parse(await readFile(`${app.executable}.starts`, 'utf8'))).toBe(1);
  await page.getByRole('button', { name: 'Allow once' }).click();
  await expect(page.getByText(/this is a task-scoped review\./i)).toBeVisible({ timeout: 20000 });
  app.releaseStartResponse();
  await expect(page).toHaveURL(new RegExp(`/reports/${app.ref.replace('.', '\\.')}/reviews\\?task=${taskId}$`));
  await page.reload();
  await expect(page.getByText(/this is a task-scoped review\./i)).toBeVisible();
  expect(JSON.parse(await readFile(`${app.executable}.starts`, 'utf8'))).toBe(1);
});

test('active task rejects a second Start before native execution and returns to the review form', async ({ app, page }) => {
  await openReview(page, app);
  await prepare(page);
  await page.getByRole('button', { name: 'Start review' }).click();
  await expect(page.getByRole('region', { name: 'Native request' })).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: 'Return to review form' }).click();
  await page.getByLabel('Profile').selectOption({ label: 'strict-review' });
  await page.getByLabel('Review prompt').fill('A second task must be refused while the first is active.');
  await page.getByRole('button', { name: 'Preview review' }).click();
  await expect(page.getByRole('region', { name: 'Review task preview' })).toBeVisible();
  await page.getByRole('button', { name: 'Start review' }).click();
  await expect(page.getByRole('alert')).toContainText('Review could not start');
  await expect(page.getByText(/A task is already starting or running/i)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Review task', level: 2 })).toHaveCount(0);
  expect(new URL(page.url()).searchParams.has('task')).toBe(false);
  expect(JSON.parse(await readFile(`${app.executable}.starts`, 'utf8'))).toBe(1);
});

test('known profile refusals return to the form with the native error and no unknown-outcome warning', async ({ app, page }) => {
  await openReview(page, app);
  const codes = ['review-profile-access-blocked', 'review-profile-access-unavailable', 'review-profile-changed', 'review-profile-busy'];
  let codeIndex = 0;
  await page.route(/\/api\/reports\/[^/]+\/review-tasks$/, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const code = codes[codeIndex++];
    await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code, message: `Native refusal: ${code}` } }) });
  });

  for (const code of codes) {
    await prepare(page);
    await page.getByRole('button', { name: 'Start review' }).click();
    await expect(page.getByRole('alert')).toContainText('Review could not start');
    await expect(page.getByRole('alert')).toContainText(`Native refusal: ${code}`);
    await expect(page.getByText(/start outcome is unknown/i)).toHaveCount(0);
    expect(new URL(page.url()).searchParams.has('task')).toBe(false);
  }
  expect(codeIndex).toBe(codes.length);
});

test('editing invalidates preview, starts no task, and review form reflows at narrow width and 200% zoom in both themes', async ({ app, page }) => {
  await openReview(page, app);
  await prepare(page);
  await page.getByLabel('Review prompt').fill('Updated prompt after preview.');
  await expect(page.getByRole('region', { name: 'Review task preview' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start review' })).toHaveCount(0);
  expect(await import('node:fs/promises').then(fs => fs.stat(`${app.executable}.starts`).then(() => true, () => false))).toBe(false);

  const previewButton = page.getByRole('button', { name: 'Preview review' });
  await previewButton.focus();
  await expect(previewButton).toBeFocused();
  await previewButton.press('Enter');
  await expect(page.getByRole('region', { name: 'Review task preview' })).toBeVisible();
  for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width: 800, height: 900 });
    await page.evaluate(themeName => {
      document.documentElement.setAttribute('data-theme', themeName);
      document.documentElement.style.zoom = '2';
    }, theme);
    const dimensions = await page.evaluate(() => {
      const overflows = [...document.querySelectorAll('*')].map(element => {
        const rect = element.getBoundingClientRect();
        return { tag: element.tagName, text: (element.textContent ?? '').trim().slice(0, 70),
          left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width),
          scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
      }).filter(item => item.right > innerWidth + 1 || item.left < -1).slice(0, 12);
      return { innerWidth, scrollWidth: document.documentElement.scrollWidth, overflows };
    });
    expect(dimensions.scrollWidth, `Horizontal overflow at ${theme}: ${JSON.stringify(dimensions.overflows)}`).toBeLessThanOrEqual(dimensions.innerWidth);
    await page.screenshot({ path: test.info().outputPath(`review-form-${theme}-800-200.png`), fullPage: true });
    await page.evaluate(() => { document.documentElement.style.zoom = ''; });
  }
});
