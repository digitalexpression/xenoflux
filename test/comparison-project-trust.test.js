import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'smol-toml';
import { applyComparisonProjectTrust, inspectComparisonProjectTrust } from '../src/comparison-project-trust.js';

async function fixture(t, client = 'codex', rootMode = 'explicit') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-project-trust-')));
  t.after(() => rm(root, { force: true, recursive: true }));
  const home = join(root, 'profile'), repository = join(root, 'a repo."with quotes"');
  await Promise.all([mkdir(home, { mode: 0o700 }), mkdir(repository)]);
  const profile = { client, rootMode, home, userHome: root, bindingRepository: repository };
  const path = join(client === 'claude-code' && rootMode === 'implicit' ? root : home,
    { codex: 'config.toml', 'claude-code': '.claude.json', copilot: 'config.json' }[client]);
  return {
    root, repository, profile, path,
    inspect: () => inspectComparisonProjectTrust(profile, repository),
    apply: plan => applyComparisonProjectTrust(profile, repository, plan),
  };
}

test('read-only plan and explicit Start add only the canonical Codex project entry', async t => {
  const f = await fixture(t);
  const original = '# Keep the native settings and comments.\nmodel = "fixture"\n[projects."/other"]\ntrust_level = "untrusted"\n';
  await writeFile(f.path, original, { mode: 0o640 });
  const plan = await f.inspect();
  assert.equal(plan.status, 'needs-trust');
  assert.equal(await readFile(f.path, 'utf8'), original);
  await f.apply(plan);
  const text = await readFile(f.path, 'utf8');
  assert.ok(text.startsWith(original));
  assert.equal(parse(text).projects[f.repository].trust_level, 'trusted');
  assert.equal(parse(text).projects['/other'].trust_level, 'untrusted');
  assert.equal((await lstat(f.path)).mode & 0o777, 0o640);
  await f.apply(await f.inspect());
  assert.equal(await readFile(f.path, 'utf8'), text);
});

test('existing Codex table is edited in place, and a missing config is created privately', async t => {
  const f = await fixture(t);
  assert.equal((await f.inspect()).status, 'needs-trust');
  await assert.rejects(readFile(f.path), { code: 'ENOENT' });
  await f.apply(await f.inspect());
  assert.equal((await lstat(f.path)).mode & 0o777, 0o600);
  assert.equal((await f.inspect()).status, 'trusted');
  const header = `[projects.${JSON.stringify(f.repository)}] # Preserve this table\r\n`;
  await writeFile(f.path, `${header}other = true\r\n`);
  await f.apply(await f.inspect());
  assert.equal(await readFile(f.path, 'utf8'), `${header}trust_level = "trusted"\r\nother = true\r\n`);
});

test('a denied native project decision stays in place', async t => {
  const codex = await fixture(t);
  const toml = `[projects.${JSON.stringify(codex.root)}]\ntrust_level = "untrusted"\n`;
  await writeFile(codex.path, toml, { mode: 0o600 });
  assert.equal((await codex.inspect()).status, 'denied');
  await assert.rejects(codex.apply(await codex.inspect()), /explicitly marks/);
  assert.equal(await readFile(codex.path, 'utf8'), toml);

  const claude = await fixture(t, 'claude-code');
  const json = JSON.stringify({ projects: { [claude.repository]: { hasTrustDialogAccepted: false } } });
  await writeFile(claude.path, json, { mode: 0o600 });
  assert.equal((await claude.inspect()).status, 'denied');
  await assert.rejects(claude.apply(await claude.inspect()), /explicitly marks/);
  assert.equal(await readFile(claude.path, 'utf8'), json);
});

test('Claude and Copilot update the expected native stores and retain unrelated fields', async t => {
  for (const rootMode of ['explicit', 'implicit']) {
    const f = await fixture(t, 'claude-code', rootMode);
    const config = { projects: { [f.repository]: { allowlists: ['fixtures'] }, '/other': { keep: true } }, unrelated: { n: 6 } };
    await writeFile(f.path, JSON.stringify(config), { mode: 0o600 });
    await f.apply(await f.inspect());
    config.projects[f.repository].hasTrustDialogAccepted = true;
    assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), config);
    assert.equal((await f.inspect()).status, 'trusted');
  }

  const f = await fixture(t, 'copilot');
  const config = { trustedFolders: ['/other'], unrelated: { n: 7 } };
  await writeFile(f.path, JSON.stringify(config), { mode: 0o600 });
  await f.apply(await f.inspect());
  config.trustedFolders.push(f.repository);
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), config);
  assert.equal((await f.inspect()).status, 'trusted');
});

test('config changes and repository replacements invalidate reviewed trust', async t => {
  const f = await fixture(t);
  let plan = await f.inspect();
  const text = 'model = "fixture-updated"\n';
  await writeFile(f.path, text, { mode: 0o600 });
  await assert.rejects(f.apply(plan), /changed/);
  plan = await f.inspect();
  await rename(f.repository, join(f.root, 'original'));
  await mkdir(f.repository);
  await assert.rejects(f.apply(plan), /changed/);
  assert.equal(await readFile(f.path, 'utf8'), text);
});

test('unsafe or unparsable native settings produce a generic error', async t => {
  const f = await fixture(t);
  await writeFile(f.path, 'PRIVATE_CONFIG_VALUE [', { mode: 0o600 });
  await assert.rejects(f.inspect(), { message: 'Project trust settings are unavailable or unsafe.' });
  await writeFile(f.path, '');
  await chmod(f.path, 0o666);
  await assert.rejects(f.inspect(), /unsafe/);
  await rm(f.path);
  const outside = join(f.root, 'other.toml');
  await writeFile(outside, '', { mode: 0o600 });
  await symlink(outside, f.path);
  await assert.rejects(f.inspect(), /unsafe/);
  await assert.rejects(inspectComparisonProjectTrust(f.profile, f.root), /unsafe/);
});
