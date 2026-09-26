import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { desktopChoicePlan, pickDesktop, selectDesktop } from '../src/desktop-picker.js';

test('the Default profile is pickable even when there are no profiles', async () => {
  let entries;
  const selected = await pickDesktop({}, {
    listHomes: async () => [],
    currentDesktop: async () => ({ status: 'unmanaged', activeProfile: null }),
    pickProfile: async listed => { entries = listed; return listed[0].id; },
  });
  assert.deepEqual(selected, { kind: 'default' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'Default profile');
  assert.equal(entries[0].state, 'ready');
  assert.match(entries[0].description, /leave the current app unchanged/);
});

test('inspection previews the selected choice', async () => {
  const calls = [];
  const choice = await pickDesktop({}, {
    listHomes: async () => [{ id: 'alpha', name: 'Alpha', state: 'ready' }],
    currentDesktop: async () => ({ status: 'active', recoveryRequired: false }),
    selectionPlan: async (_store, id) => { calls.push(id); return { profileId: id, preview: true }; },
    pickProfile: async (entries, options) => {
      const defaultProfile = await options.inspect(entries[0].id);
      const named = await options.inspect(entries[1].id);
      assert.equal(defaultProfile.launch, 'ordinary-app');
      assert.equal(defaultProfile.homeOverrides, 'none');
      assert.equal(defaultProfile.reservationAction, 'release-on-restoration');
      assert.equal(defaultProfile.lifecycleActionsPerformed, false);
      assert.deepEqual(named, { profileId: 'alpha', preview: true });
      return null;
    },
  });
  assert.equal(choice, null);
  assert.deepEqual(calls, ['alpha']);
});

test('default entry offers restoration only for a clean active selection', async () => {
  const states = [
    [{ status: 'active', recoveryRequired: false }, 'ready', /Restore the ordinary Codex desktop/],
    [{ status: 'restored', recoveryRequired: false }, 'ready', /leave the current app unchanged/],
    [{ status: 'unmanaged', recoveryRequired: false }, 'ready', /leave the current app unchanged/],
    [{ status: 'incomplete', recoveryRequired: true }, 'unavailable', /desktop recover/],
  ];
  for (const [current, state, description] of states) {
    await pickDesktop({}, {
      currentDesktop: async () => current,
      listHomes: async () => [],
      pickProfile: async entries => {
        assert.equal(entries[0].state, state);
        assert.match(entries[0].description, description);
        return null;
      },
    });
  }
});

test('default preview performs no native calls', async () => {
  let selected = false;
  const plan = await desktopChoicePlan({}, { kind: 'default' }, {
    selectionPlan: async () => { selected = true; throw Error('must not inspect a native home'); },
  });
  assert.equal(selected, false);
  assert.deepEqual(plan, {
    kind: 'default', operation: 'restore', launch: 'ordinary-app',
    homeOverrides: 'none', reservationAction: 'release-on-restoration',
    lifecycleActionsPerformed: false,
    whenUnmanaged: 'leave-unchanged', whenNoPriorSelection: 'leave-unchanged',
    liveHomeChanged: false,
  });
});

test('named previews forward runtime and other planner options', async () => {
  const runtime = { fixture: true };
  let received;
  const result = await desktopChoicePlan({}, { kind: 'profile', profileId: 'alpha' }, {
    runtime,
    selectionPlan: async (_store, id, options) => { received = { id, options }; return { profileId: id }; },
  });
  assert.deepEqual(result, { profileId: 'alpha' });
  assert.equal(received.id, 'alpha');
  assert.equal(received.options.runtime, runtime);
});

test('selection routes Default, named, and cancelled choices without native lifecycle calls', async () => {
  const calls = [];
  const options = {
    runtime: { ignored: true },
    switchDesktop: async (store, id, forwarded) => { calls.push(['switch', store, id, forwarded.runtime]); return { status: 'active' }; },
    restoreDesktop: async (store, forwarded) => { calls.push(['restore', store, forwarded.runtime]); return { status: 'restored' }; },
  };
  const store = { fixture: true };
  assert.deepEqual(await selectDesktop(store, { kind: 'default' }, options), { status: 'restored' });
  assert.deepEqual(await selectDesktop(store, { kind: 'profile', profileId: 'alpha' }, options), { status: 'active' });
  assert.deepEqual(await selectDesktop(store, null, options), { status: 'cancelled' });
  assert.deepEqual(calls, [['restore', store, options.runtime], ['switch', store, 'alpha', options.runtime]]);
});

test('picker supports explicit cancellation and EOF', async () => {
  for (const text of ['q\n', '']) {
    const input = new PassThrough(), output = new PassThrough();
    const pending = pickDesktop({}, { currentDesktop: async () => ({ status: 'unmanaged' }), listHomes: async () => [], input, output });
    input.end(text);
    assert.equal(await pending, null);
  }
});
