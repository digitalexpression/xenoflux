import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createCopilotDecoder } from '../src/copilot-events.js';

const sessionId = '00000000-0000-4000-8000-000000000009';
const cwd = '/private/tmp/fixture-marker';
async function events() {
  return JSON.parse((await readFile(new URL('./fixtures/copilot/live-marker-events.json', import.meta.url), 'utf8')).replaceAll('@WORKSPACE@', cwd));
}

test('captured marker shapes retain the exact final answer, opaque turns, typed exit and root idle', async () => {
  const decoder = createCopilotDecoder({ sessionId, cwd });
  for (const event of await events()) decoder.consume(event);
  const decoded = decoder.snapshot();
  assert.equal(decoded.complete, true);
  assert.equal(decoded.response.text, 'Marker created.');
  assert.equal(decoded.response.turnId, '1');
  assert.deepEqual(decoded.turns.map(turn => turn.turnId), ['0', '1']);
  assert.equal(decoded.turns.at(-1).reasoningEffort, 'medium');
  assert.equal(decoded.turns.at(-1).model, 'fixture-routed-model');
  assert.equal(decoded.invocations[0].exitCode, 0);
  assert.equal(decoded.toolsComplete, true);
  assert.equal(decoded.replayEvents.at(-1).kind, 'session');
  assert.equal(decoded.replayEvents.at(-1).status, 'completed');
  const final = decoded.replayEvents.find(row => row.label === 'Assistant final answer');
  assert.equal(final.text, 'Marker created.');
  assert.equal(final.turnId, '1');
  assert.ok(decoded.replayEvents.some(row => row.kind === 'tool-result' && JSON.parse(row.text).exitCode === 0));
  assert.equal(decoded.replayEvents.at(-1).id, decoded.idle.id);
});

test('missing or aborted idle keeps final content partial and cannot manufacture completion', async () => {
  for (const mode of ['missing', 'aborted']) {
    const decoder = createCopilotDecoder({ sessionId, cwd });
    const rows = await events();
    if (mode === 'missing') rows.pop();
    else rows.at(-1).data.aborted = true;
    for (const event of rows) decoder.consume(event);
    const decoded = decoder.snapshot();
    assert.equal(decoded.complete, false);
    assert.equal(decoded.response.status, 'partial');
    assert.equal(decoded.replayEvents.some(row => row.kind === 'session' && row.status === 'completed'), false);
  }
});

test('an unknown shell exit remains unknown independently from a completed root response', async () => {
  const decoder = createCopilotDecoder({ sessionId, cwd });
  for (const event of await events()) {
    if (event.type === 'tool.execution_complete') event.data.result.contents = [];
    decoder.consume(event);
  }
  assert.equal(decoder.snapshot().complete, true);
  assert.equal(decoder.snapshot().toolsComplete, false);
  assert.equal(decoder.snapshot().invocations[0].exitCode, null);
});
