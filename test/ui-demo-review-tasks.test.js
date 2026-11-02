import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoProvider } from '../src/ui-demo.js';

test('demo review task is visibly simulated, idempotent, readable, and navigates to a frozen report', async () => {
  const demo = createDemoProvider();
  const view = await demo.reviews({ ref: 'demo-run' });
  assert.equal(view.reviewOptions.profiles.length > 0, true);
  assert.equal(view.reviewOptions.workspaces[0].path, '/demo/date-utils');

  const preview = await demo.previewReviewTask({ ref: 'demo-run', profile: 'strict-review' });
  assert.equal(preview.simulated, true);
  assert.match(preview.summary, /no model will run/i);
  assert.equal(preview.model, 'Not run');
  assert.deepEqual(preview.inputs.map(input => input.name), ['report.md', 'report.md.audit.json', 'prompt.md']);
  for (const input of preview.inputs) assert.ok(preview.effectivePrompt.includes(input.source));
  const started = await demo.startReviewTask({ ref: 'demo-run', previewToken: preview.previewToken });
  assert.deepEqual(await demo.startReviewTask({ ref: 'demo-run', previewToken: preview.previewToken }), started);

  const task = await demo.reviewTask({ id: started.id });
  assert.equal(task.status, 'completed');
  assert.equal(task.simulated, true);
  assert.equal(task.response.status, 'complete');
  assert.equal(task.response.threadId, null);
  assert.equal(task.response.turnId, null);
  assert.match(task.response.text, /not a model response/i);
  assert.equal(task.nativeSettings, null);
  assert.equal(task.shutdown, null);
  assert.equal(task.reportRef, `r.${started.id}`);
  const frozen = await demo.report({ ref: task.reportRef });
  assert.equal(frozen.ref, task.reportRef);
  assert.equal(frozen.frozen, true);
  const frozenReviews = await demo.reviews({ ref: task.reportRef });
  assert.equal(frozenReviews.ref, task.reportRef);
  assert.equal(frozenReviews.reviewTasks[0].id, started.id);
  assert.equal((await demo.cancelReviewTask({ id: started.id })).status, 'completed');
  assert.equal((await demo.reviews({ ref: 'demo-run' })).reviewTasks[0].id, started.id);
});
