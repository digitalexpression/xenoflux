import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, create } from '../src/profiles.js';
import { registerHome } from '../src/homes.js';
import { prepareNativeHome } from '../test-support/native-home-fixture.js';
import { createEngineProvider } from '../src/ui-engine.js';

async function put(directory, name, content, mode = 0o600) {
  await mkdir(join(directory, name, '..'), { recursive: true, mode: 0o700 });
  await writeFile(join(directory, name), content, { mode });
}
const text = path => readFile(path, 'utf8');
const idle = async () => ({ cli: { state: 'not-running', text: 'not running' }, desktop: { state: 'not-running', text: 'not running' } });

async function fixture(t, { observeClients = idle, copyRuntime = () => ({ assertIdle: async () => {} }), resolveClient } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-ui-setup-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'codex');
  await writeFile(executable, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const a = await prepareNativeHome({ directory: join(root, 'native-a'), executable, codexVersion: '0.153.4' });
  const b = await prepareNativeHome({ directory: join(root, 'native-b'), executable, codexVersion: '0.153.4' });
  const store = new Store(join(root, 'store'));
  await store.update(data => { create(data, 'baseline'); create(data, 'strict-review'); });
  await registerHome(store, 'baseline', a.root, { executable, version: '0.153.4' });
  await registerHome(store, 'strict-review', b.root, { executable, version: '0.153.4' });
  await put(a.home, 'AGENTS.md', 'Run the test suite before proposing a commit.\n');
  await put(b.home, 'AGENTS.md', 'Run the full test suite and lint before proposing a commit.\nExplain every skipped check.\n');
  await put(a.home, 'config.toml', 'allow_symlinked_codex_home = true\ncli_auth_credentials_store = "file"\nmodel_reasoning_effort = "medium"\n');
  await put(b.home, 'config.toml', 'allow_symlinked_codex_home = true\ncli_auth_credentials_store = "file"\nmodel_reasoning_effort = "high"\n');
  await put(b.home, 'skills/release-notes/SKILL.md', '---\nname: release-notes\ndescription: Notes.\n---\nWrite notes.\n');
  await put(a.home, 'skills/changing-skill/SKILL.md', '---\nname: changing-skill\ndescription: Notes.\n---\nWrite notes.\n');
  await put(b.home, 'skills/changing-skill/SKILL.md', '---\nname: changing-skill\ndescription: Notes.\n---\nWrite notes.\n');
  await put(b.home, 'skills/changing-skill/extra.txt', Array.from({ length: 15 }, (_, i) => `right-only line ${i + 1}`).join('\n'));
  await put(b.home, 'auth.json', 'credential sentinel');
  const defaultUserHome = join(root, 'user');
  await mkdir(join(defaultUserHome, '.codex'), { recursive: true, mode: 0o700 });
  await put(join(defaultUserHome, '.codex'), 'AGENTS.md', 'Default instructions.\n');
  const calls = [];
  const clientOps = Object.fromEntries(['openTerminal', 'showTerminal', 'openDefaultDesktop', 'openDesktop', 'focusDesktop']
    .map(name => [name, async (...args) => { calls.push([name, ...args]); }]));
  const provider = createEngineProvider({ store, defaultUserHome, observeClients, copyRuntime, clientOps,
    resolveClient: resolveClient ?? (async () => ({ executable, version: '0.153.4' })), profilesBase: join(root, 'profiles'),
    lockOptions: { lockPath: join(root, 'global.lock'), concurrentLockPath: join(root, 'desktop.lock') }, reportsRoot: join(root, 'reports') });
  return { root, store, a, b, provider, calls, defaultUserHome };
}

test('setup comparison groups real differences with plain labels and copy links', async t => {
  const f = await fixture(t);
  const view = await f.provider.setupComparison({ a: 'baseline', b: 'strict-review' });
  assert.ok(view.counts.different >= 2, JSON.stringify(view.counts));
  const items = view.groups.flatMap(group => group.items);
  const agents = items.find(item => item.name === 'AGENTS.md' && item.scope === 'Profile');
  assert.equal(agents.label, 'different');
  assert.ok(agents.detail.diff.some(line => line.kind === '+' && /lint/.test(line.text)));
  assert.match(agents.actions.copy.href, /^\/profiles\/baseline\/copy\?from=strict-review&item=/);
  const effort = items.find(item => item.name === 'model_reasoning_effort');
  assert.deepEqual(effort.summary.map(part => part.text), ['medium', ' → ', 'high']);
  const skill = items.find(item => item.name === 'release-notes');
  assert.equal(skill.exactState, 'added');
  assert.equal(skill.exactText, 'Only in strict-review');
  assert.ok(items.every(item => item.detail.facts.some(fact => fact.label === 'Used by a session')));
  const same = await f.provider.setupComparison({ a: 'baseline', b: 'baseline' });
  assert.equal(same.blocked, 'Choose two different profiles.');
  // Inspection never copies or writes.
  assert.equal(await text(join(f.a.home, 'AGENTS.md')), 'Run the test suite before proposing a commit.\n');
});

test('Default comparison groups integration evidence, preserves namespaces and never changes profiles', async t => {
  const f = await fixture(t);
  const defaultHome = join(f.defaultUserHome, '.codex');
  await put(defaultHome, 'config.toml', '[mcp_servers.memory]\nenabled = true\n[plugins."security@market"]\nenabled = false\n');
  await put(defaultHome, 'plugins/cache/market/security/revision/.codex-plugin/plugin.json', '{"name":"security","version":"1.0"}');
  await put(f.b.home, 'config.toml', '[plugins."review@market"]\nenabled = true\n');
  await put(f.b.home, 'plugins/cache/market/review/v2/.codex-plugin/plugin.json', '{"name":"review","version":"2.0"}');
  await put(f.b.home, 'plugins/cache/other/review/v2/.codex-plugin/plugin.json', '{"name":"review","version":"2.0"}');
  const paths = [f.store.file, join(defaultHome, 'config.toml'), join(f.b.home, 'config.toml')];
  const before = await Promise.all(paths.map(text));
  const view = await f.provider.setupComparison({ a: 'Default', b: 'strict-review' });
  const integrations = view.groups.find(group => group.id === 'integrations').items;
  const memory = integrations.filter(item => item.name === 'memory');
  assert.equal(memory.length, 1);
  assert.equal(memory[0].label, 'same', 'the complete shared configuration matches; runtime use remains a separate unknown');
  assert.equal(memory[0].detail.evidence.length, 1);
  assert.deepEqual(memory[0].detail.evidence[0].detail.sources.map(source => source.side), ['a', 'b']);
  assert.doesNotMatch(JSON.stringify(memory), /no corroborating record/);
  const security = integrations.filter(item => item.name === 'security@market');
  assert.equal(security.length, 1);
  assert.equal(security[0].detail.evidence.length, 2);
  const review = integrations.filter(item => item.name === 'review@market');
  assert.equal(review.length, 1);
  assert.equal(review[0].detail.evidence.length, 2);
  assert.match(review[0].detail.values.find(box => box.side === 'b').value, /1 configuration source; 1 cached package/);
  const other = integrations.find(item => item.name === 'review@other');
  assert.equal(other.detail.evidence.length, 1, 'same name from another marketplace stays separate');
  assert.equal(other.actions.guidance, undefined, 'cache-only evidence never proposes installation');
  assert.ok(view.groups.flatMap(group => group.items).every(item => !item.actions.copy || !['mcp', 'plugin', 'hook'].includes(item.category)));
  assert.deepEqual(await Promise.all(paths.map(text)), before);
  assert.deepEqual(f.calls, []);
});

test('local setup comparison shows arbitrary source fields without changing public report values or profiles', async t => {
  const f = await fixture(t);
  const contents = '[desktop]\nnotifications = false\n[provider]\napi_key = "fixture-local-value"\n[mcp_servers.reader]\ncommand = "/opt/example/reader"\nargs = ["--mode", "local"]\n[mcp_servers.reader.env]\nCUSTOM_TOKEN = "fixture-env-value"\n';
  for (const home of [f.a.home, f.b.home]) await put(home, 'config.toml', contents);
  const paths = [f.store.file, join(f.a.home, 'config.toml'), join(f.b.home, 'config.toml')];
  const before = await Promise.all(paths.map(text));
  const view = await f.provider.setupComparison({ a: 'baseline', b: 'strict-review' });
  const items = view.groups.flatMap(group => group.items);
  const provider = items.find(item => item.name === 'provider' && item.scope === 'Profile');
  assert.equal(provider.label, 'same');
  assert.match(provider.detail.values[0].value, /fixture-local-value/);
  assert.match(provider.detail.values[0].value, /\n/);
  const reader = items.find(item => item.name === 'reader');
  assert.equal(reader.label, 'same');
  const record = reader.detail.evidence[0];
  assert.match(record.detail.values[0].value, /\/opt\/example\/reader/);
  assert.match(record.detail.values[0].value, /fixture-env-value/);
  assert.match(record.detail.note, /runtime availability and session use are not established/);
  assert.equal(reader.detail.facts.find(fact => fact.label === 'Used by a session').value, 'Not known from setup alone');
  assert.equal(view.limits.coverage.find(row => row.area === 'Profile config').a, 'Read in full');
  assert.doesNotMatch(JSON.stringify(items), /not a recognized safe setting|undisclosed values/);
  assert.deepEqual(await Promise.all(paths.map(text)), before);
  assert.deepEqual(f.calls, []);
});

test('skill detail returns the actual lines from a source-only package file', async t => {
  const f = await fixture(t);
  const detail = await f.provider.skillDetail({ skill: 'changing-skill', a: 'baseline', b: 'strict-review' });
  const extra = detail.files.find(file => file.path === 'extra.txt');
  assert.equal(extra.only.side, 'b');
  assert.equal(extra.only.lines.length, 15);
  assert.match(extra.only.lines[0], /right-only line 1/);
  await assert.rejects(f.provider.skillDetail({ skill: 'changing-skill', a: 'baseline', b: 'strict-review', item: 'stale-package-identity' }), { status: 404 });
});

test('copy preview, selective apply and undo follow the copy policy', async t => {
  const f = await fixture(t);
  const view = await f.provider.setupComparison({ a: 'baseline', b: 'strict-review' });
  const agents = view.groups.flatMap(group => group.items).find(item => item.name === 'AGENTS.md' && item.scope === 'Profile');
  const item = new URLSearchParams(agents.actions.copy.href.split('?')[1]).get('item');
  const plan = await f.provider.copyPlan({ target: 'baseline', from: 'strict-review', item });
  assert.equal(plan.items.find(entry => entry.selected)?.name, 'AGENTS.md', JSON.stringify(plan.items.map(entry => [entry.name, entry.kind])));
  assert.ok(plan.never[0].includes('credentials'));
  assert.ok(plan.items.every(entry => entry.name !== 'auth.json'));
  await assert.rejects(f.provider.copyApply({ target: 'baseline', from: 'strict-review', items: [], planToken: plan.planToken }), /at least one/);
  const chosen = plan.items.filter(entry => entry.name === 'AGENTS.md').map(entry => entry.id);
  const applied = await f.provider.copyApply({ target: 'baseline', from: 'strict-review', items: chosen, planToken: plan.planToken });
  assert.equal(applied.status, 'applied');
  assert.match(await text(join(f.a.home, 'AGENTS.md')), /lint/);
  // Unselected settings stay as they are.
  assert.match(await text(join(f.a.home, 'config.toml')), /"medium"/);
  const undone = await f.provider.copyUndo({ id: applied.undo.id });
  assert.equal(undone.status, 'undone');
  assert.equal(await text(join(f.a.home, 'AGENTS.md')), 'Run the test suite before proposing a commit.\n');

  // Undo refuses to overwrite a later edit.
  const again = await f.provider.copyPlan({ target: 'baseline', from: 'strict-review' });
  const second = await f.provider.copyApply({ target: 'baseline', from: 'strict-review', items: again.items.filter(entry => entry.name === 'AGENTS.md').map(entry => entry.id), planToken: again.planToken });
  await writeFile(join(f.a.home, 'AGENTS.md'), 'Edited afterwards.\n');
  await assert.rejects(f.provider.copyUndo({ id: second.undo.id }), error => error.code === 'undo-refused');
  assert.equal(await text(join(f.a.home, 'AGENTS.md')), 'Edited afterwards.\n');
});

test('copy links keep full skill identity when names share a long prefix', async t => {
  const f = await fixture(t);
  const prefix = 'shared-' + 'a'.repeat(88);
  const first = `${prefix}-first`, second = `${prefix}-second`;
  for (const name of [first, second]) await put(f.b.home, `skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: Notes.\n---\nWrite notes.\n`);
  const view = await f.provider.setupComparison({ a: 'baseline', b: 'strict-review' });
  const item = view.groups.flatMap(group => group.items).find(entry => entry.name === second && entry.scope === 'Profile');
  assert.ok(item?.actions.copy);
  const selected = new URLSearchParams(item.actions.copy.href.split('?')[1]).get('item');
  const plan = await f.provider.copyPlan({ target: 'baseline', from: 'strict-review', item: selected });
  assert.deepEqual(plan.items.filter(entry => entry.selected).map(entry => entry.name), [second]);
});

test('setup copy links require the item on the proposed source side', async t => {
  const f = await fixture(t);
  await put(f.a.home, 'skills/baseline-only/SKILL.md', '---\nname: baseline-only\ndescription: Baseline only.\n---\nCheck changes.\n');
  for (const [a, b, absent, present] of [
    ['baseline', 'strict-review', 'baseline-only', 'release-notes'],
    ['strict-review', 'baseline', 'release-notes', 'baseline-only'],
    ['Default', 'baseline', 'config.toml', 'AGENTS.md'],
    ['baseline', 'Default', 'config.toml', 'AGENTS.md'],
  ]) {
    const view = await f.provider.setupComparison({ a, b });
    const items = view.groups.flatMap(group => group.items);
    const missing = items.find(item => item.name === absent && item.scope === 'Profile');
    assert.ok(missing, `${a}/${b} exposes ${absent}`);
    assert.equal(missing.actions.copy, undefined, `${a}/${b} cannot copy ${absent} from the missing source`);
    assert.ok(items.find(item => item.name === present && item.scope === 'Profile')?.actions.copy, `${a}/${b} retains ${present} copy`);
  }
});

test('setup copy preselection works when Default is the source on the left', async t => {
  const f = await fixture(t);
  const view = await f.provider.setupComparison({ a: 'Default', b: 'strict-review' });
  const instructions = view.groups.flatMap(group => group.items).find(entry => entry.name === 'AGENTS.md' && entry.scope === 'Profile');
  const item = new URLSearchParams(instructions.actions.copy.href.split('?')[1]).get('item');
  const plan = await f.provider.copyPlan({ target: 'strict-review', from: 'Default', item });
  assert.deepEqual(plan.items.filter(entry => entry.selected).map(entry => entry.name), ['AGENTS.md']);
});

test('a source change after preview, or an open client, stops the copy with nothing written', async t => {
  const f = await fixture(t, { copyRuntime: () => ({ assertIdle: async () => { throw Object.assign(new Error('CLI_RUNNING'), { code: 'CLI_RUNNING' }); } }) });
  const plan = await f.provider.copyPlan({ target: 'baseline', from: 'strict-review' });
  const ids = plan.items.filter(entry => entry.name === 'AGENTS.md').map(entry => entry.id);
  await assert.rejects(f.provider.copyApply({ target: 'baseline', from: 'strict-review', items: ids, planToken: plan.planToken }), error => error.code === 'client-open');
  assert.equal(await text(join(f.a.home, 'AGENTS.md')), 'Run the test suite before proposing a commit.\n');
  await writeFile(join(f.b.home, 'AGENTS.md'), 'Changed after the preview.\n');
  await assert.rejects(f.provider.copyApply({ target: 'baseline', from: 'strict-review', items: ids, planToken: plan.planToken }), error => error.code === 'changed');
  await assert.rejects(f.provider.copyApply({ target: 'baseline', from: 'strict-review', items: ids, planToken: 'expired' }), error => error.code === 'changed');
  await assert.rejects(f.provider.copyPlan({ target: 'Default', from: 'baseline' }), /copied from, not into/);
});

test('creates a profile from selected parts, edits and removes profiles without touching files', async t => {
  const f = await fixture(t);
  await assert.rejects(f.provider.createPlan({ name: 'baseline' }), error => error.code === 'name-taken');
  const plan = await f.provider.createPlan({ name: 'careful-tests', from: 'strict-review' });
  const agents = plan.items.find(entry => entry.name === 'AGENTS.md');
  assert.ok(agents);
  const created = await f.provider.createApply({ name: 'careful-tests', from: 'strict-review', items: [agents.id], planToken: plan.planToken });
  assert.match(created.title, /careful-tests created/, JSON.stringify(created));
  const profiles = (await f.provider.profiles()).profiles;
  const card = profiles.find(profile => profile.name === 'careful-tests');
  assert.equal(card.signIn, 'No sign-in saved');
  assert.deepEqual(card.clientActions.map(action => action.id), ['signin']);
  const data = await f.store.read();
  const home = join(data.profiles.find(profile => profile.name === 'careful-tests').native.root, 'codex-home');
  assert.match(await text(join(home, 'AGENTS.md')), /lint/);
  await assert.rejects(text(join(home, 'auth.json')), { code: 'ENOENT' });

  await f.provider.renameProfile({ name: 'careful-tests', newName: 'careful' });
  await f.provider.bindProfile({ name: 'careful', repository: f.root });
  assert.equal((await f.store.read()).profiles.find(profile => profile.name === 'careful').repositories[0].path, f.root);
  await f.provider.removeProfile({ name: 'careful' });
  assert.equal((await f.store.read()).profiles.some(profile => profile.name === 'careful'), false);
  assert.match(await text(join(home, 'AGENTS.md')), /lint/, 'removal keeps the files');
  await assert.rejects(f.provider.renameProfile({ name: 'Default', newName: 'x' }), /can’t be renamed/);
});

test('creating from a preview refuses changed selected source content before creating a profile', async t => {
  const f = await fixture(t);
  const plan = await f.provider.createPlan({ name: 'changed-source', from: 'strict-review' });
  const agents = plan.items.find(entry => entry.name === 'AGENTS.md');
  await writeFile(join(f.b.home, 'AGENTS.md'), 'Changed after the create preview.\n');
  await assert.rejects(f.provider.createApply({ name: 'changed-source', from: 'strict-review', items: [agents.id], planToken: plan.planToken }), error => error.code === 'changed');
  assert.equal((await f.store.read()).profiles.some(profile => profile.name === 'changed-source'), false);
});

test('creating from a preview refuses selected package directory mode changes', async t => {
  const f = await fixture(t);
  const plan = await f.provider.createPlan({ name: 'changed-directory', from: 'strict-review' });
  const skill = plan.items.find(entry => entry.name === 'release-notes');
  assert.ok(skill);
  const skillHome = join(f.b.home, 'skills', skill.name);
  await chmod(skillHome, 0o750);
  await assert.rejects(f.provider.createApply({ name: 'changed-directory', from: 'strict-review', items: [skill.id], planToken: plan.planToken }));
  assert.equal((await f.store.read()).profiles.some(profile => profile.name === 'changed-directory'), false);
});

test('creating refuses added selected skill files but allows changes to unselected settings', async t => {
  const f = await fixture(t);
  const plan = await f.provider.createPlan({ name: 'changed-package', from: 'strict-review' });
  const skill = plan.items.find(entry => entry.name === 'release-notes');
  await put(f.b.home, 'skills/release-notes/extra.txt', 'Added after preview.\n');
  await assert.rejects(f.provider.createApply({ name: 'changed-package', from: 'strict-review', items: [skill.id], planToken: plan.planToken }), error => error.code === 'changed');
  assert.equal((await f.store.read()).profiles.some(profile => profile.name === 'changed-package'), false);

  const instructions = await f.provider.createPlan({ name: 'instructions-only', from: 'strict-review' });
  const config = join(f.b.home, 'config.toml');
  await writeFile(config, (await text(config)).replace('model_reasoning_effort = "high"', 'model_reasoning_effort = "low"'));
  const agents = instructions.items.find(entry => entry.name === 'AGENTS.md');
  const result = await f.provider.createApply({ name: 'instructions-only', from: 'strict-review', items: [agents.id], planToken: instructions.planToken });
  assert.equal(result.title, 'instructions-only created');
  const profile = (await f.store.read()).profiles.find(entry => entry.name === 'instructions-only');
  assert.equal(await text(join(profile.native.root, 'codex-home', 'AGENTS.md')), await text(join(f.b.home, 'AGENTS.md')));
});

test('an unsafe unselected skill does not block creating from safe instructions', async t => {
  const f = await fixture(t);
  await put(f.b.home, 'skills/release-notes/secret.txt', 'api_key = "sk-fixture12345678901234567890"\n');
  const plan = await f.provider.createPlan({ name: 'safe-parts', from: 'strict-review' });
  assert.equal(plan.items.some(entry => entry.name === 'release-notes'), false);
  assert.ok(plan.manual.some(text => text.includes('release-notes')));
  const agents = plan.items.find(entry => entry.name === 'AGENTS.md');
  const result = await f.provider.createApply({ name: 'safe-parts', from: 'strict-review', items: [agents.id], planToken: plan.planToken });
  assert.equal(result.title, 'safe-parts created');
});

test('source changes during preparation leave a clear partial creation without copying changed instructions', async t => {
  const f = await fixture(t, { resolveClient: async () => {
    await writeFile(join(f.b.home, 'AGENTS.md'), 'Changed during preparation.\n');
    return { executable: join(f.root, 'codex'), version: '0.153.4' };
  } });
  const plan = await f.provider.createPlan({ name: 'source-race', from: 'strict-review' });
  const agents = plan.items.find(entry => entry.name === 'AGENTS.md');
  const result = await f.provider.createApply({ name: 'source-race', from: 'strict-review', items: [agents.id], planToken: plan.planToken });
  assert.equal(result.title, 'source-race created; its settings weren’t copied');
  const profile = (await f.store.read()).profiles.find(entry => entry.name === 'source-race');
  await assert.rejects(text(join(profile.native.root, 'codex-home', 'AGENTS.md')), { code: 'ENOENT' });
});

test('client controls run only on request and refuse a CLI/Desktop conflict', async t => {
  const running = async home => home.includes('native-a')
    ? { cli: { state: 'running', text: 'running (PID 1)' }, desktop: { state: 'not-running', text: 'not running' } } : idle();
  const f = await fixture(t, { observeClients: running });
  const cards = (await f.provider.profiles()).profiles;
  assert.equal(f.calls.length, 0, 'listing profiles operates no client');
  const baseline = cards.find(card => card.name === 'baseline');
  assert.deepEqual(baseline.clientActions.map(action => action.id), ['show-terminal', 'open-desktop']);
  assert.ok(baseline.clientActions[1].conflict);
  await assert.rejects(f.provider.clientAction({ name: 'baseline', action: 'open-desktop' }), error => error.code === 'client-conflict');
  assert.equal(f.calls.length, 0);
  await f.provider.clientAction({ name: 'strict-review', action: 'open-terminal' });
  assert.deepEqual(f.calls, [['openTerminal', ['launch', 'strict-review']]]);
  await f.provider.clientAction({ name: 'baseline', action: 'show-terminal' });
  assert.equal(f.calls.at(-1)[0], 'showTerminal');
  await assert.rejects(f.provider.clientAction({ name: 'baseline', action: 'format-disk' }), error => error.code === 'invalid-action');
});

test('copy refuses a preview whose destination name now identifies another profile', async t => {
  const f = await fixture(t);
  await put(f.a.home, 'AGENTS.md', await text(join(f.b.home, 'AGENTS.md')));
  const plan = await f.provider.copyPlan({ from: 'Default', target: 'strict-review' });
  const item = plan.items.find(entry => entry.name === 'AGENTS.md');
  const before = await Promise.all([text(join(f.a.home, 'AGENTS.md')), text(join(f.b.home, 'AGENTS.md'))]);
  await f.provider.renameProfile({ name: 'strict-review', newName: 'old-destination' });
  await f.provider.renameProfile({ name: 'baseline', newName: 'strict-review' });
  await assert.rejects(f.provider.copyApply({ from: 'Default', target: 'strict-review', items: [item.id], planToken: plan.planToken }), { code: 'changed' });
  assert.deepEqual(await Promise.all([text(join(f.a.home, 'AGENTS.md')), text(join(f.b.home, 'AGENTS.md'))]), before);
});

test('copy fingerprints bind raw destination bytes while allowing unselected setting edits', async t => {
  const f = await fixture(t);
  const first = 'api_key = "sk-123456789012345678901234567890"\n';
  const second = 'api_key = "sk-abcdefghijklmnopqrstuvwxyz1234"\n';
  await put(f.b.home, 'AGENTS.md', first);
  const plan = await f.provider.copyPlan({ from: 'Default', target: 'strict-review' });
  const item = plan.items.find(entry => entry.name === 'AGENTS.md');
  await put(f.b.home, 'AGENTS.md', second);
  const fresh = await f.provider.copyPlan({ from: 'Default', target: 'strict-review' });
  assert.deepEqual(fresh.items.find(entry => entry.id === item.id).details, item.details, 'the redacted previews are identical');
  await assert.rejects(f.provider.copyApply({ from: 'Default', target: 'strict-review', items: [item.id], planToken: plan.planToken }), { code: 'changed' });
  assert.equal(await text(join(f.b.home, 'AGENTS.md')), second);
  await put(f.b.home, 'config.toml', (await text(join(f.b.home, 'config.toml'))).replace('model_reasoning_effort = "high"', 'model_reasoning_effort = "low"'));
  const applied = await f.provider.copyApply({ from: 'Default', target: 'strict-review', items: [item.id], planToken: fresh.planToken });
  assert.equal(applied.status, 'applied');
  assert.match(await text(join(f.b.home, 'config.toml')), /"low"/);
  assert.equal(await text(join(f.b.home, 'AGENTS.md')), 'Default instructions.\n');
});

test('copy rechecks reviewed bytes after client preparation under its transaction lock', async t => {
  let destination, replacement;
  const f = await fixture(t, { copyRuntime: () => ({
    prepareClients: async () => { await writeFile(destination, replacement); }, assertIdle: async () => {},
  }) });
  destination = join(f.b.home, 'AGENTS.md');
  replacement = 'Edited while waiting for client preparation.\n';
  const plan = await f.provider.copyPlan({ from: 'Default', target: 'strict-review' });
  const item = plan.items.find(entry => entry.name === 'AGENTS.md');
  await assert.rejects(f.provider.copyApply({ from: 'Default', target: 'strict-review', items: [item.id], planToken: plan.planToken }), { code: 'changed' });
  assert.equal(await text(destination), replacement);
});

test('setup cache distinguishes profile pairs containing separators', async t => {
  const f = await fixture(t);
  const names = ['A|B', 'C', 'A', 'B|C'];
  for (const [index, name] of names.entries()) {
    const native = await prepareNativeHome({ directory: join(f.root, `cache-${index}`), executable: join(f.root, 'codex'), codexVersion: '0.153.4' });
    await f.store.update(data => create(data, name));
    await registerHome(f.store, name, native.root, { executable: join(f.root, 'codex'), version: '0.153.4' });
    await put(native.home, 'config.toml', `allow_symlinked_codex_home = true\nmodel = "model-${index}"\n`);
  }
  await f.provider.setupComparison({ a: 'A|B', b: 'C' });
  const view = await f.provider.setupComparison({ a: 'A', b: 'B|C' });
  const model = view.groups.flatMap(group => group.items).find(item => item.name === 'model');
  assert.deepEqual(model.summary.map(part => part.text), ['model-2', ' → ', 'model-3']);
});
