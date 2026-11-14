import { test, expect } from '@playwright/test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createUiBrowserFixture } from '../../test-support/ui-browser-fixture.js';
import { bookingLedgerPair } from '../../test-support/audit-explanation/booking-ledger.js';
import { compareAuditRuns } from '../../src/audit-report.js';
import { projectSessionReplay } from '../../src/audit-session-replay.js';

function controlsPair(changedEffort) {
  return bookingLedgerPair().map((run, index) => {
    const sessionId = `00000000-0000-4000-8000-00000000000${index + 1}`;
    const turnId = `00000000-0000-4000-8000-00000000010${index + 1}`;
    const model = index ? 'comparison-model-b' : 'comparison-model-a';
    run.profile.profileName = index ? 'strict-review' : 'baseline';
    run.clientIdentity = { client: 'codex', surface: 'cli', executionLocation: 'local' };
    run.source.nativeSessionId = sessionId;
    run.agents[0].id = sessionId;
    run.agents[0].source.fingerprint = run.source.fingerprint;
    run.turns[0] = { ...run.turns[0], agentId: sessionId, turnId, model,
      reasoningEffort: changedEffort && index ? 'low' : 'high' };
    run.comparisonConditions.selectedSkills = [];
    run.settingsEvidence = { requested: { model, reasoningEffort: 'high', permissionMode: 'workspace-write' } };
    run.sessionReplay = projectSessionReplay([{ id: sessionId, sourceFingerprint: run.source.fingerprint, records: [
      { sourceLine: 1, record: { type: 'event_msg', timestamp: '2026-11-13T10:00:00Z', payload: { type: 'user_message', message: 'Synthetic comparison task.', turn_id: turnId } } },
      { sourceLine: 2, record: { type: 'compacted', timestamp: '2026-11-13T10:00:05Z', payload: { message: index ? 'Right retained compaction summary.' : 'Left retained compaction summary.', turn_id: turnId } } },
    ] }]);
    return run;
  });
}

function ownedControlsPair() {
  return controlsPair(true).map((run, index) => {
    const turn = run.turns[0], sessionId = turn.agentId;
    run.source = { ...run.source, kind: 'native-app-server-v2', threadId: sessionId };
    turn.status = 'completed';
    run.settingsEvidence.requested.reasoningEffort = turn.reasoningEffort;
    run.settingsEvidence.sent = { ...run.settingsEvidence.requested };
    run.settingsEvidence.confirmed = { ...run.settingsEvidence.requested };
    run.comparisonConditions.checkRecipes = [];
    run.checks = [];
    run.nativeControls = { schemaVersion: 1,
      configured: { model: null, modelReasoningEffort: null, planModeReasoningEffort: null, loginMethod: null },
      startup: { agentId: sessionId, model: turn.model, reasoningEffort: turn.reasoningEffort, source: 'thread/start' },
      turns: [{ agentId: sessionId, turnId: turn.turnId, model: turn.model, reasoningEffort: turn.reasoningEffort,
        source: 'turn_context', sourceLine: 3, sourceFingerprint: run.source.fingerprint, workspaceMatched: true }] };
    run.coverage = { ...run.coverage, agents: 'complete', timeline: 'complete', skillInventory: 'complete', skillUsage: 'partial',
      skillInvocationTelemetry: 'observed', captureRequirements: 'complete', tools: 'none-recorded', hooks: 'none-recorded' };
    const sourceTime = { schemaVersion: 1,
      nativeEvent: { source: 'event.timestamp', clock: 'producer-reported', unixNano: '1794597132233000000' },
      otlpEvent: { source: 'timeUnixNano', clock: 'otlp-event', unixNano: null },
      otlpObserved: { source: 'observedTimeUnixNano', clock: 'otlp-observed', unixNano: '1794597132233858000' },
      clockRelationship: 'unknown' };
    run.skills = [{ id: 'observed-review', name: 'observed-review', observations: [
      { kind: 'native-selection-accepted', agentId: sessionId, turnId: turn.turnId, evidence: 'structured turn/start skill input' },
      { kind: 'definition-read-observed', agentId: sessionId, turnId: turn.turnId, sourceLine: index ? 70 : 59,
        itemId: `skill-read-${index}`, evidence: { source: 'app-server-command' } },
      { kind: 'native-invocation-observed', agentId: sessionId, turnId: turn.turnId, metadata: {
        source: 'native-otel-skill-invocation', observationId: `receipt-${index}:1`, invocationType: 'explicit', sourceTime } },
      { kind: 'native-invocation-observed', agentId: sessionId, turnId: turn.turnId, metadata: {
        source: 'native-otel-skill-invocation', observationId: `receipt-${index}:2`, invocationType: 'implicit', sourceTime } },
    ] }, { id: 'catalog-only-review', name: 'catalog-only-review', observations: [], catalogs: [{ source: 'skills/list', agentId: sessionId }] }];
    run.sessionReplay = projectSessionReplay([{ id: sessionId, sourceFingerprint: run.source.fingerprint, records: [
      { sourceLine: 2, record: { type: 'response_item', payload: { type: 'additional_tools', tools: [
        { type: 'namespace', name: 'functions', tools: [{ type: 'function', name: 'exec' }] },
      ] } } },
      { sourceLine: 4, record: { type: 'event_msg', payload: { type: 'task_complete', turn_id: turn.turnId } } },
    ] }]);
    return run;
  });
}

for (const [theme, width] of [['light', 1280], ['dark', 320]]) {
  test(`owned comparison preserves available evidence and explains remaining coverage in ${theme}`, async ({ page }, testInfo) => {
    const app = await createUiBrowserFixture();
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(value => localStorage.setItem('xenoflux-theme', value), theme);
      const pair = compareAuditRuns(...ownedControlsPair());
      const opened = await app.provider.openReport({ fileName: 'owned-comparison.audit.json', text: JSON.stringify(pair) });
      await page.goto(app.url);
      await page.getByRole('heading', { name: 'What do you want to compare?', exact: true }).waitFor();
      await page.goto(`${app.origin}/reports/${encodeURIComponent(opened.ref)}`);
      await expect(page.getByText('Model task completed', { exact: true })).toHaveCount(2);
      await expect(page.getByText('Task completion not recorded', { exact: true })).toHaveCount(0);
      const comparison = page.getByRole('region', { name: 'Session and harness comparison', exact: true });
      await comparison.getByRole('button', { name: 'Inspect each session’s harness evidence', exact: true }).click();
      await expect(comparison.getByText('Retained xfx capture', { exact: true })).toHaveCount(2);
      await expect(comparison.getByText('Skill catalog', { exact: true })).toHaveCount(2);
      await expect(comparison.getByText('Skill use', { exact: true })).toHaveCount(2);
      await expect(comparison.getByText('Required capture', { exact: true })).toHaveCount(2);
      await expect(comparison.getByText(/^No checks selected/)).toHaveCount(2);
      await expect(comparison.getByText('Recorded observations do not establish every skill that was loaded or invoked.', { exact: true })).toHaveCount(2);
      await expect(comparison.getByText('Confirmed: comparison-model-a', { exact: true })).toHaveCount(1);
      await expect(comparison.getByText('Confirmed: comparison-model-b', { exact: true })).toHaveCount(1);
      await comparison.getByRole('button', { name: 'Turn setting observations (1)', exact: true }).first().click();
      await comparison.getByRole('button', { name: 'Turn setting observations (1)', exact: true }).click();
      await expect(comparison.getByText(/Retained native turn context .* Source line 3/)).toHaveCount(2);
      await comparison.getByRole('button', { name: 'Skill observations (1)', exact: true }).first().click();
      await comparison.getByRole('button', { name: 'Skill observations (1)', exact: true }).click();
      await expect(comparison.getByText(/native-selection-accepted .* Structured selection · structured turn\/start skill input/)).toHaveCount(2);
      await expect(comparison.getByText(/definition-read-observed .* Source line 59 · Item skill-read-0/)).toHaveCount(1);
      await expect(comparison.getByText(/definition-read-observed .* Source line 70 · Item skill-read-1/)).toHaveCount(1);
      await expect(comparison.getByText(/native-invocation-observed .* Native telemetry · explicit .* Producer event 2026-11-13T19:12:12.233000000Z/)).toHaveCount(2);
      await expect(comparison.getByText(/native-invocation-observed .* Native telemetry · implicit/)).toHaveCount(2);
      await expect(comparison.getByText(/source line unknown/i)).toHaveCount(0);
      await expect(comparison.getByRole('button', { name: 'Catalog-only skills (1)', exact: true })).toHaveCount(2);
      await comparison.getByRole('button', { name: 'Telemetry clock details', exact: true }).first().click();
      await expect(comparison.getByText('otlp-observed · observedTimeUnixNano · 2026-11-13T19:12:12.233858000Z', { exact: true })).toBeVisible();
      await expect(comparison.getByText('Clock relationship unknown. These timestamps do not establish delivery latency.', { exact: true })).toBeVisible();
      await comparison.getByRole('button', { name: 'Hide telemetry clock details', exact: true }).click();
      await expect(page.getByRole('button', { name: /^Unsupported native item:/ })).toHaveCount(0);
      await page.getByRole('button', { name: /^Offered tool catalog/ }).last().click();
      const inspector = page.getByRole('dialog', { name: 'Event inspector' });
      await expect(inspector.getByText(/offered-not-invoked/)).toBeVisible();
      await page.keyboard.press('Escape');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`owned-evidence-${theme}.png`) });
      const exported = await app.provider.exportReport({ ref: opened.ref, includeReplayContent: true });
      const saved = await app.provider.openReport({ fileName: exported.files[1], text: await readFile(join(exported.folder, exported.files[1]), 'utf8') });
      const reopened = await app.provider.report({ ref: saved.ref });
      expect(reopened.sessionControls).toEqual((await app.provider.report({ ref: opened.ref })).sessionControls);
      expect(reopened.sessionHarness).toEqual((await app.provider.report({ ref: opened.ref })).sessionHarness);
    } finally { await app.close(); }
  });
}

for (const [theme, width, effortChanged] of [['light', 1280, false], ['dark', 320, true]]) {
  test(`paired harness controls distinguish requested model-only from observed changes in ${theme}`, async ({ page }, testInfo) => {
    const app = await createUiBrowserFixture();
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(value => localStorage.setItem('xenoflux-theme', value), theme);
      const value = compareAuditRuns(...controlsPair(effortChanged));
      const opened = await app.provider.openReport({ fileName: 'comparison.audit.json', text: JSON.stringify(value) });
      await page.goto(app.url);
      await page.getByRole('heading', { name: 'What do you want to compare?', exact: true }).waitFor();
      await page.goto(`${app.origin}/reports/${encodeURIComponent(opened.ref)}`);
      const comparison = page.getByRole('region', { name: 'Session and harness comparison', exact: true });
      await expect(comparison.getByText('Model-only request', { exact: true })).toBeVisible();
      await expect(comparison.getByText(effortChanged ? 'Harness controls differ' : 'Observed models differ', { exact: true })).toBeVisible();
      await expect(comparison.getByText('Historical equivalence is not established', { exact: true })).toBeVisible();
      await comparison.getByRole('heading', { name: 'Session and harness comparison', exact: true }).evaluate(element => element.scrollIntoView({ block: 'start' }));
      await page.screenshot({ path: testInfo.outputPath(`comparison-summary-${theme}.png`) });
      await comparison.getByRole('button', { name: /Inspect recorded controls/ }).click();
      const table = comparison.getByRole('table', { name: 'Recorded session controls comparison' });
      await expect(table.getByRole('row').filter({ has: page.getByText('Native observed reasoning effort set', { exact: true }) }).getByRole('rowheader')).toContainText(effortChanged ? 'Different' : 'Same');
      await comparison.getByRole('button', { name: 'Inspect each session’s harness evidence', exact: true }).click();
      const summaries = comparison.getByRole('button', { name: 'Recorded compaction summary', exact: true });
      await summaries.last().focus(); await page.keyboard.press('Enter');
      const inspector = page.getByRole('dialog', { name: 'Event inspector' });
      await expect(inspector.getByText('Right retained compaction summary.', { exact: true })).toBeVisible();
      await expect(inspector.getByText('Left retained compaction summary.', { exact: true })).toHaveCount(0);
      await page.keyboard.press('Escape');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`paired-harness-${theme}.png`), fullPage: true });
      const exported = await app.provider.exportReport({ ref: opened.ref, includeReplayContent: true });
      const markdown = await readFile(join(exported.folder, exported.files[0]), 'utf8');
      expect(markdown).toContain('Requested comparison: Model-only request');
      const frozen = await app.provider.openReport({ fileName: exported.files[1], text: await readFile(join(exported.folder, exported.files[1]), 'utf8') });
      await page.goto(`${app.origin}/reports/${encodeURIComponent(frozen.ref)}`);
      await expect(page.getByText(effortChanged ? 'Harness controls differ' : 'Observed models differ', { exact: true })).toBeVisible();
    } finally { await app.close(); }
  });
}

test('single inspection carries its frozen side into a newly chosen session comparison', async ({ page }, testInfo) => {
  const app = await createUiBrowserFixture();
  try {
    const row = (await app.provider.sessions({ query: 'Fix the date test', profile: 'baseline' })).sessions[0];
    const inspection = await app.provider.inspectSession({ key: row.key });
    await rm(app.rollouts[0]);
    await page.goto(app.url);
    await page.getByRole('heading', { name: 'What do you want to compare?', exact: true }).waitFor();
    await page.goto(`${app.origin}/sessions/${encodeURIComponent(inspection.ref)}`);
    await page.getByRole('link', { name: 'Compare with another session', exact: true }).click();
    await expect(page.getByText('Left session is retained', { exact: true })).toBeVisible();
    await page.getByRole('combobox', { name: 'Profile', exact: true }).selectOption('codex:strict-review');
    await page.getByRole('button', { name: 'List recent sessions', exact: true }).click();
    await page.getByRole('button', { name: 'Compare with Fix the date test', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Session and harness comparison', exact: true })).toBeVisible();
    await expect(page.getByText('Retained comparison', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy CLI command', exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Left timeline', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Right timeline', exact: true })).toBeVisible();
    await page.getByRole('heading', { name: 'Session and harness comparison', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('retained-comparison.png') });
  } finally { await app.close(); }
});
