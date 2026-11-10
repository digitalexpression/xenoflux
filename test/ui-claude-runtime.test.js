import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { createUiRunsFixture } from '../test-support/ui-runs-fixture.js';

async function until(action, done, label) {
  let last;
  for (let i = 0; i < 300; i++) {
    last = await action();
    if (done(last)) return last;
    await setTimeout(25);
  }
  assert.fail(label + ': ' + JSON.stringify(last));
}

test('ordinary Claude review uses the selected profile, frozen inputs and pinned SDK through the controller', async t => {
  const app = await createUiRunsFixture({ mode: { mixedClaude: true }, reviewContext: {
    accessOptions: { inspectResources: async () => [] } } });
  t.after(() => app.close());
  const comparison = await app.provider.runPreview({ task: 'Fixture comparison', a: 'baseline', b: 'strict-review',
    repository: app.repository, commit: 'HEAD', checks: [] });
  assert.equal(comparison.ready, true);
  const started = await app.provider.startRun({ previewToken: comparison.previewToken });
  const run = await until(() => app.provider.run(started), value => ['finished', 'finished-partial', 'failed'].includes(value.state), 'Source comparison');
  assert.equal(run.state, 'finished', JSON.stringify(run));
  const ref = 'e.' + started.id;
  const selection = { profile: 'Default', client: 'claude-code', workspace: app.repository };
  assert.equal((await app.provider.catalog(selection)).status, 'unavailable');
  const discovered = await app.provider.refreshCatalog({ ...selection, requestId: randomUUID() });
  assert.equal(discovered.status, 'ready', JSON.stringify(discovered));
  assert.equal(discovered.scope.environmentBinding.client, 'claude-code');
  assert.equal((await app.provider.catalog(selection)).models[0].model, 'sonnet');
  assert.equal((await app.provider.catalog({ profile: 'Default', workspace: app.repository })).status, 'unavailable');
  const preview = await app.provider.previewReviewTask({ ref, profile: 'Default', client: 'claude-code', cwd: app.repository,
    prompt: 'Inspect these frozen files.', execution: { model: 'sonnet', reasoningEffort: 'low' } });
  assert.match(preview.summary, /ordinary Claude Code review/);
  const task = await app.provider.startReviewTask({ ref, previewToken: preview.previewToken });
  const repeated = await app.provider.startReviewTask({ ref, previewToken: preview.previewToken });
  assert.equal(repeated.id, task.id);
  const result = await until(() => app.provider.reviewTask(task), value =>
    ['completed', 'failed', 'uncertain'].includes(value.status) && value.shutdown !== null, 'Claude review');
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.response.text, 'Claude fixture completed.');
  assert.equal(result.nativeReference.client, 'claude-code');
  assert.equal(result.nativeReference.turnId, null);
  assert.equal(result.nativeReference.sessionId, result.response.threadId);
  assert.equal(result.shutdown.groupTerminated, true);
});
