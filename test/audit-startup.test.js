import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile, readdir, link } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareAuditStartup } from '../src/audit-startup.js';
import { probeAuditVersion } from '../src/audit-native-version.js';

test('macOS startup policy blocks saved profile refreshes while allowing runtime and child writes', async t => {
  if (process.platform !== 'darwin') { t.skip('sandbox-exec policy enforcement is macOS-only'); return; }
  const root = await mkdtemp(join(tmpdir(), 'xfx-audit-startup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const canonicalRoot = await realpath(root);
  const home = join(canonicalRoot, 'profile');
  const userHome = join(canonicalRoot, 'user');
  const runtime = join(canonicalRoot, 'runtime');
  const workspace = join(canonicalRoot, 'workspace');
  await mkdir(home);
  await mkdir(userHome);
  await mkdir(runtime);
  await mkdir(workspace);
  await mkdir(join(home, 'skills', '.system'), { recursive: true });
  await mkdir(join(home, 'skills', 'custom'));
  await mkdir(join(home, 'agents'));
  await mkdir(join(home, 'rules'));
  await mkdir(join(userHome, '.agents', 'skills', 'local-skill'), { recursive: true });
  const originals = new Map([
    ['auth.json', '{"token":"fixture"}'], ['config.toml', 'model = "fixture"\n'],
    ['AGENTS.md', 'saved instructions\n'], ['AGENTS.override.md', 'saved override\n'], ['instructions.md', 'saved instructions\n'],
    ['skills/.system/README.md', 'saved system skill\n'], ['skills/custom/README.md', 'saved custom skill\n'],
    ['agents/worker.toml', 'saved agent\n'], ['rules/deny.md', 'saved rule\n'],
  ]);
  for (const [relative, contents] of originals) await writeFile(join(home, relative), contents);
  await writeFile(join(userHome, '.agents', 'skills', 'local-skill', 'SKILL.md'), 'saved user skill\n');
  await symlink(join(home, 'auth.json'), join(home, 'auth-alias.json'));
  await symlink(join(home, 'skills', '.system'), join(home, 'system-skill-alias'));
  const external = join(canonicalRoot, 'external-skill');
  await mkdir(external);
  await writeFile(join(external, 'SKILL.md'), 'external saved skill\n');
  await symlink(external, join(home, 'skills', 'external'));

  let prepared;
  try {
    prepared = await prepareAuditStartup({ profile: { home, userHome, executable: process.execPath }, directory: join(runtime, 'policy'),
      args: ['-e', childProgram, home, runtime, workspace, userHome] });
  } catch (error) {
    // An unsupported sandbox_init in the host environment is a real test blocker.
    assert.fail(`Could not prepare/enforce macOS sandbox policy: ${error.message}`);
  }
  const result = spawnSync(prepared.executable, prepared.args, { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /protected=16/);
  assert.equal(await readFile(join(runtime, 'native-runtime.txt'), 'utf8'), 'runtime-ok');
  assert.equal(await readFile(join(workspace, 'workspace.txt'), 'utf8'), 'workspace-ok');
  assert.equal(await readFile(join(home, 'rollouts', 'new-session.json'), 'utf8'), 'session-ok');
  for (const [relative, contents] of originals) assert.equal(await readFile(join(home, relative), 'utf8'), contents, relative);
  assert.equal(await readFile(join(userHome, '.agents', 'skills', 'local-skill', 'SKILL.md'), 'utf8'), 'saved user skill\n');
  assert.equal(await readFile(join(external, 'SKILL.md'), 'utf8'), 'external saved skill\n');
  assert.ok(!(await readdir(home)).some(name => /tmp|backup/.test(name)));
});

const childProgram = String.raw`
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const [home, runtime, workspace, userHome] = process.argv.slice(1);
let protectedCount = 0;
function denied(fn) { try { fn(); } catch (e) { if (e.code === 'EPERM' || e.code === 'EACCES') { protectedCount++; return; } throw e; } throw Error('protected profile write unexpectedly succeeded'); }
denied(() => fs.writeFileSync(path.join(home, 'auth.json'), 'bad'));
denied(() => fs.writeFileSync(path.join(home, '.tmp-random-atomic-save'), 'credential-copy'));
denied(() => fs.writeFileSync(path.join(home, 'auth.json.backup'), 'credential-copy'));
denied(() => fs.renameSync(home, home + '-moved'));
denied(() => { const p = path.join(home, 'config.toml.tmp'); fs.writeFileSync(p, 'bad'); fs.renameSync(p, path.join(home, 'config.toml')); });
denied(() => fs.writeFileSync(path.join(home, 'skills/.system/README.md'), 'bad'));
denied(() => fs.writeFileSync(path.join(home, 'skills/custom/README.md'), 'bad'));
denied(() => fs.writeFileSync(path.join(home, 'skills/external/SKILL.md'), 'bad'));
denied(() => fs.writeFileSync(path.join(home, 'system-skill-alias/README.md'), 'bad'));
denied(() => fs.writeFileSync(path.join(home, 'auth-alias.json'), 'bad'));
denied(() => fs.chmodSync(path.join(home, 'auth.json'), 0o600));
denied(() => fs.writeFileSync(path.join(home, 'agents/worker.toml'), 'bad'));
denied(() => fs.writeFileSync(path.join(home, 'instructions.md'), 'bad'));
denied(() => fs.writeFileSync(path.join(home, 'rules/deny.md'), 'bad'));
denied(() => fs.writeFileSync(path.join(home, 'AGENTS.override.md'), 'bad'));
denied(() => fs.writeFileSync(path.join(userHome, '.agents/skills/local-skill/SKILL.md'), 'bad'));
fs.mkdirSync(path.join(home, 'rollouts'), { recursive: true }); fs.writeFileSync(path.join(home, 'rollouts/new-session.json'), 'session-ok');
fs.writeFileSync(path.join(runtime, 'native-runtime.txt'), 'runtime-ok');
fs.writeFileSync(path.join(workspace, 'workspace.txt'), 'workspace-ok');
const child = cp.spawnSync(process.execPath, ['-e', "require('fs').writeFileSync(process.argv[1], 'child-ok')", path.join(runtime, 'child.txt')], { encoding: 'utf8' });
if (child.status !== 0) throw Error(child.stderr);
if (fs.readFileSync(path.join(runtime, 'child.txt'), 'utf8') !== 'child-ok') throw Error('child exec did not run');
process.stdout.write('protected=' + protectedCount);
`;

test('version discovery cannot rewrite the selected synthetic profile', async t => {
  if (process.platform !== 'darwin') { t.skip('macOS-only write guard'); return; }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-version-startup-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'profile'); await mkdir(home);
  const config = join(home, 'config.toml'); await writeFile(config, 'saved\n');
  const binary = join(root, 'codex');
  await writeFile(binary, '#!/bin/sh\nprintf bad > "$CODEX_HOME/config.toml"\nprintf "codex-cli 99.2.1\\n"\n', { mode: 0o700 });
  assert.equal(await probeAuditVersion({ executable: binary, env: { HOME: root, CODEX_HOME: home }, cwd: root }), '99.2.1');
  assert.equal(await readFile(config, 'utf8'), 'saved\n');
  await assert.rejects(prepareAuditStartup({ profile: { home, executable: binary }, directory: root }), { code: 'EEXIST' });
});

test('command transition preserves parent writes, denies helper re-entry and does not reach sandboxed commands', async t => {
  if (process.platform !== 'darwin') { t.skip('macOS-only transition'); return; }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-command-transition-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'); await mkdir(home);
  const saved = join(home, 'auth.json'); await writeFile(saved, 'synthetic-auth');
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  const alias = join(root, 'native-alias'); await symlink(process.execPath, alias);
  const program = String.raw`
    const {spawnSync}=require('node:child_process'), fs=require('node:fs');
    const [saved,alias]=process.argv.slice(1), native=process.execPath;
    try {fs.writeFileSync(saved,'bad');throw Error('parent write permitted')} catch(e) {if(e.code!=='EPERM')throw e}
    const inner='(version 1)(allow default)(deny file-write* (literal '+JSON.stringify(saved)+'))';
    const good=spawnSync('/usr/bin/sandbox-exec',['-p',inner,'/usr/bin/true'],{encoding:'utf8'});
    if(good.status!==0)throw Error('native transition failed: '+good.stderr);
    for(const target of [native,alias]) {
      const child=spawnSync('/bin/sh',['-c','exec "$1" -e "process.stdout.write(123)"','helper',target],{encoding:'utf8'});
      if(child.status===0||child.stdout)throw Error('helper re-entered native');
      if(!child.stderr.includes('Operation not permitted'))throw Error('helper refusal was not enforcement');
    }
    const helper=spawnSync('/bin/sh',['-c','exec /usr/bin/sandbox-exec -p "(version 1)(allow default)" /usr/bin/touch "$1"','helper',saved],{encoding:'utf8'});
    if(helper.status!==71||!helper.stderr.includes('sandbox_apply'))throw Error('helper escaped guard');
    const nested=spawnSync('/usr/bin/sandbox-exec',['-p',inner,'/usr/bin/sandbox-exec','-p','(version 1)(allow default)','/usr/bin/touch',saved],{encoding:'utf8'});
    if(nested.status!==71||!nested.stderr.includes('sandbox_apply'))throw Error('task inherited transition');
    console.log('transition-and-denials-verified');
  `;
  // Node supplies a native-image canary for both supported command shapes.
  // The direct form must retain all parent, helper and task-child denials.
  await writeFile(join(root, 'exec'), `process.argv = [process.argv[0], ${JSON.stringify(saved)}, ${JSON.stringify(alias)}];\n${program}`);
  for (const [mode, args] of [
    ['app-server', ['-e', program, saved, alias, 'app-server']],
    ['exec', ['exec', '--json', '--sandbox', 'workspace-write', '--cd', workspace, '--', 'canary']],
  ]) {
    const launch = await prepareAuditStartup({profile:{home,userHome:root,executable:process.execPath},
      directory:join(root,`policy-${mode}`),args,commandSandbox:true});
    const result = spawnSync(launch.executable, launch.args, {cwd:root,encoding:'utf8',timeout:10000});
    assert.equal(result.status,0,`${mode}: ${result.stderr}`);
    assert.match(result.stdout,/transition-and-denials-verified/);
    assert.equal(await readFile(saved,'utf8'),'synthetic-auth');
  }
  for (const args of [
    ['login'], ['exec', '--dangerously-bypass-approvals-and-sandbox', 'app-server'],
    ['exec', '--json', '--sandbox', 'danger-full-access', '--cd', root, '--', 'task'],
    ['exec', '--json', '--sandbox', 'workspace-write', '--cd', root, '-c', 'sandbox_mode="danger-full-access"'],
  ]) await assert.rejects(prepareAuditStartup({profile:{home,executable:process.execPath},
    directory:join(root,'unsupported-policy'),args,commandSandbox:true}), /Invalid audit startup/);
  const homeAlias = join(root, 'home-alias'); await symlink(home, homeAlias);
  for (const [index, cwd] of [root, homeAlias].entries())
    await assert.rejects(prepareAuditStartup({profile:{home,executable:process.execPath},
      directory:join(root,`overlap-${index}`),
      args:['exec','--json','--sandbox','workspace-write','--cd',cwd,'--','canary'],commandSandbox:true}), /overlaps protected/);
});

test('native config is validated separately and prefixed before exact direct CLI task args', async t => {
  if (process.platform !== 'darwin') { t.skip('macOS-only startup policy'); return; }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-startup-native-config-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), workspace = join(root, 'workspace');
  await mkdir(home); await mkdir(workspace);
  const args = ['exec', '--json', '--sandbox', 'workspace-write', '--cd', workspace, '--', 'canary'];
  const config = { 'agents.max_depth': 1, model: 'gpt-6-astra', model_reasoning_effort: 'low' };
  const prepared = await prepareAuditStartup({ profile: { home, executable: process.execPath },
    directory: join(root, 'policy'), args, nativeConfig: config, commandSandbox: true });
  assert.deepEqual(prepared.args.slice(3, 9), ['-c', 'agents.max_depth=1', '-c', 'model="gpt-6-astra"',
    '-c', 'model_reasoning_effort="low"']);
  assert.deepEqual(prepared.args.slice(9), args, 'validated config is prefixed only after the exact task args pass validation');
  let invalidConfigIndex = 0;
  for (const nativeConfig of [
    { sandbox_mode: 'danger-full-access' }, { shell_environment_policy: 'inherit' },
    { model_reasoning_effort: 'arbitrary' }, { 'agents.max_depth': 5 },
  ]) await assert.rejects(prepareAuditStartup({ profile: { home, executable: process.execPath },
    directory: join(root, `invalid-native-config-${invalidConfigIndex++}`), args,
    nativeConfig, commandSandbox: true }), /Invalid audit startup native config/);
  for (const overlayArgs of [
    ['exec', '--json', '--sandbox', 'workspace-write', '--cd', workspace, '-c', 'sandbox_mode="danger-full-access"'],
    ['-c', 'model="gpt-6-astra"', ...args],
  ]) await assert.rejects(prepareAuditStartup({ profile: { home, executable: process.execPath },
    directory: join(root, `invalid-overlay-${invalidConfigIndex++}`), args: overlayArgs, commandSandbox: true }), /Invalid audit startup protection options/);
});

test('packaged Codex CLI wrapper grants the command transition to its verified native image', async t => {
  if (process.platform !== 'darwin') { t.skip('macOS-only transition'); return; }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-codex-wrapper-startup-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, 'ChatGPT.app'), cliRoot = join(app, 'Contents', 'Resources', 'codex-cli');
  const wrapperDir = join(cliRoot, 'bin'), nativeDir = join(cliRoot, 'CodexCLI.app', 'Contents', 'MacOS');
  const home = join(root, 'profile'), userHome = join(root, 'user'), workspace = join(root, 'workspace');
  for (const path of [wrapperDir, nativeDir, home, userHome, workspace]) await mkdir(path, { recursive: true });
  const wrapper = join(wrapperDir, 'codex'), nativeImage = join(nativeDir, 'codex');
  const wrapperText = [
    '#!/bin/sh', 'set -eu', 'entry="$0"', 'while [ -L "$entry" ]; do',
    '  parent=$(CDPATH= cd -P -- "$(dirname -- "$entry")" && pwd)', '  entry=$(readlink "$entry")',
    '  case "$entry" in /*) ;; *) entry="$parent/$entry" ;; esac', 'done',
    'bin_dir=$(CDPATH= cd -P -- "$(dirname -- "$entry")" && pwd)',
    'exec "$bin_dir/../CodexCLI.app/Contents/MacOS/codex" "$@"', '',
  ].join('\n');
  await writeFile(wrapper, wrapperText, { mode: 0o700 });
  await symlink(await realpath(process.execPath), nativeImage);
  await assert.rejects(prepareAuditStartup({ profile: { home, userHome, executable: wrapper }, directory: join(root, 'symlink-policy'),
    args: ['app-server'], commandSandbox: true }), /Packaged Codex CLI process image is unavailable/);
  await rm(nativeImage);
  await copyFile(process.execPath, nativeImage);
  const saved = join(home, 'auth.json'), output = join(workspace, 'workspace.txt');
  await writeFile(saved, 'synthetic-auth');
  const program = String.raw`
    const fs=require('node:fs'),{spawnSync}=require('node:child_process');
    const [saved,output,native]=process.argv.slice(1);
    try { fs.writeFileSync(saved,'changed'); throw Error('saved profile write was permitted'); }
    catch(e) { if(e.code!=='EPERM'&&e.code!=='EACCES') throw e; }
    const inner='(version 1)(allow default)(deny file-write* (literal '+JSON.stringify(saved)+'))';
    const child=spawnSync('/usr/bin/sandbox-exec',['-p',inner,native,'-e',"require('node:fs').writeFileSync(process.argv[1],'bad')",saved],{encoding:'utf8'});
    if(child.status===0 || !/operation not permitted|Permission denied|EPERM/.test(child.stderr)) throw Error('inner command sandbox was not applied: '+child.stderr);
    fs.writeFileSync(output,'workspace-ok');
    process.stdout.write('wrapper-image-transition-verified');
  `;
  const launch = await prepareAuditStartup({ profile: { home, userHome, executable: wrapper }, directory: join(root, 'policy'),
    args: ['-e', program, saved, output, nativeImage, 'app-server'], commandSandbox: true });
  const policy = await readFile(launch.args[1], 'utf8');
  const native = await realpath(nativeImage);
  assert.equal(launch.args[2], native);
  assert.ok(policy.includes(`(with-filter (process-path "${native}") (allow process-exec`));
  assert.ok(policy.includes(`(deny file-write* (literal "${wrapper}")`));
  const result = spawnSync(launch.executable, launch.args, { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /wrapper-image-transition-verified/);
  assert.equal(await readFile(saved, 'utf8'), 'synthetic-auth');
  assert.equal(await readFile(output, 'utf8'), 'workspace-ok');
});

test('unrecognized packaged Codex wrapper fails closed before command sandboxing', async t => {
  if (process.platform !== 'darwin') { t.skip('macOS-only transition'); return; }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-unknown-wrapper-startup-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cliRoot = join(root, 'Codex.app', 'Contents', 'Resources', 'codex-cli');
  const wrapperDir = join(cliRoot, 'bin'), nativeDir = join(cliRoot, 'CodexCLI.app', 'Contents', 'MacOS'), home = join(root, 'home');
  await mkdir(wrapperDir, { recursive: true }); await mkdir(nativeDir, { recursive: true }); await mkdir(home);
  const wrapper = join(wrapperDir, 'codex');
  await writeFile(wrapper, '#!/bin/sh\nexec /bin/true\n', { mode: 0o700 });
  await symlink(await realpath(process.execPath), join(nativeDir, 'codex'));
  await assert.rejects(prepareAuditStartup({ profile: { home, executable: wrapper }, directory: join(root, 'policy'),
    args: ['app-server'], commandSandbox: true }), /Packaged Codex CLI wrapper cannot be verified/);
});

async function npmLayout(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-npm-codex-startup-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, 'node_modules', '@openai', 'codex');
  const platformRoot = join(packageRoot, 'node_modules', '@openai', `codex-darwin-${process.arch}`);
  const target = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`;
  const vendor = join(platformRoot, 'vendor', target);
  const native = join(vendor, 'bin', 'codex'), wrapper = join(packageRoot, 'bin', 'codex.js');
  const home = join(root, 'home'), workspace = join(root, 'workspace');
  for (const path of [join(packageRoot, 'bin'), join(vendor, 'bin'), home, workspace]) await mkdir(path, { recursive: true });
  const manifests = new Map([
    [join(packageRoot, 'package.json'), { name: '@openai/codex', type: 'module', version: '99.2.1', bin: { codex: 'bin/codex.js' } }],
    [join(platformRoot, 'package.json'), { name: '@openai/codex', version: `99.2.1-darwin-${process.arch}`, os: ['darwin'], cpu: [process.arch] }],
    [join(vendor, 'codex-package.json'), { layoutVersion: 1, version: '99.2.1', target, variant: 'codex', entrypoint: 'bin/codex' }],
  ]);
  for (const [path, value] of manifests) await writeFile(path, JSON.stringify(value));
  await copyFile(process.execPath, native);
  const marker = join(root, 'wrapper-ran');
  await writeFile(wrapper, `#!/usr/bin/env node\nimport {spawnSync} from 'node:child_process';\nimport {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)},'wrapper');\nconst r=spawnSync(${JSON.stringify(native)},process.argv.slice(2),{stdio:'inherit'});\nprocess.exit(r.status??1);\n`, { mode: 0o700 });
  const saved = join(home, 'config.toml'); await writeFile(saved, 'saved-settings');
  return { root, packageRoot, platformRoot, vendor, native, wrapper, home, workspace, marker, saved, manifests };
}

test('npm Codex launches its declared native image, preserving command sandbox and re-entry denials', async t => {
  if (process.platform !== 'darwin') { t.skip('macOS-only transition'); return; }
  const f = await npmLayout(t);
  const program = String.raw`
    const fs=require('node:fs'),{spawnSync}=require('node:child_process');
    const [saved,wrapper,native,workspace,marker]=process.argv.slice(1);
    if(fs.existsSync(marker))throw Error('package entrypoint was evaluated');
    try {fs.writeFileSync(saved,'bad');throw Error('parent wrote saved settings')} catch(e) {if(e.code!=='EPERM'&&e.code!=='EACCES')throw e}
    const inner='(version 1)(allow default)(deny file-write* (literal '+JSON.stringify(saved)+'))';
    const good=spawnSync('/usr/bin/sandbox-exec',['-p',inner,'/usr/bin/true'],{encoding:'utf8'});
    if(good.status!==0)throw Error('native transition failed: '+good.stderr);
    const denied=spawnSync('/usr/bin/sandbox-exec',['-p',inner,'/usr/bin/touch',saved],{encoding:'utf8'});
    if(denied.status===0)throw Error('task bypassed inner sandbox');
    const helper=spawnSync('/bin/sh',['-c','exec /usr/bin/sandbox-exec -p "(version 1)(allow default)" /usr/bin/touch "$1"','helper',saved],{encoding:'utf8'});
    if(helper.status!==71||!helper.stderr.includes('sandbox_apply'))throw Error('helper escaped outer guard');
    for(const target of [native,wrapper]) {
      const child=spawnSync('/bin/sh',['-c','exec "$1" --version','helper',target],{encoding:'utf8'});
      if(child.status===0)throw Error('helper re-entered native through '+target);
    }
    fs.writeFileSync(workspace+'/result.txt','workspace-ok');
    console.log('npm-native-transition-and-denials-verified');
  `;
  const launch = await prepareAuditStartup({ profile: { home: f.home, executable: f.wrapper }, directory: join(f.root, 'policy'),
    args: ['-e', program, f.saved, f.wrapper, f.native, f.workspace, f.marker, 'app-server'], commandSandbox: true });
  const policy = await readFile(launch.args[1], 'utf8');
  assert.equal(launch.args[2], f.native);
  assert.ok(policy.includes(`(with-filter (process-path "${f.native}") (allow process-exec`));
  assert.ok(!policy.includes(`(with-filter (process-path "${f.wrapper}")`));
  const result = spawnSync(launch.executable, launch.args, { cwd: f.root, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /npm-native-transition-and-denials-verified/);
  assert.equal(await readFile(f.saved, 'utf8'), 'saved-settings');
  assert.equal(await readFile(join(f.workspace, 'result.txt'), 'utf8'), 'workspace-ok');
});

test('npm command transition rejects inconsistent metadata and unsafe native images', async t => {
  if (process.platform !== 'darwin') { t.skip('macOS-only transition'); return; }
  const f = await npmLayout(t);
  const manifestPaths = [...f.manifests.keys()];
  let index = 0;
  const reject = () => assert.rejects(prepareAuditStartup({ profile: { home: f.home, executable: f.wrapper },
    directory: join(f.root, `rejected-${index++}`), args: ['app-server'], commandSandbox: true }), /npm Codex package layout cannot be verified/);
  for (const [path, value] of [
    [manifestPaths[0], { ...f.manifests.get(manifestPaths[0]), name: 'unrelated-package' }],
    [manifestPaths[0], { ...f.manifests.get(manifestPaths[0]), bin: { codex: '../../other.js' } }],
    [manifestPaths[1], { ...f.manifests.get(manifestPaths[1]), cpu: ['unsupported-architecture'] }],
    [manifestPaths[1], { ...f.manifests.get(manifestPaths[1]), version: 'different-package-version' }],
    [manifestPaths[2], { ...f.manifests.get(manifestPaths[2]), entrypoint: '../../other' }],
    [manifestPaths[2], { ...f.manifests.get(manifestPaths[2]), layoutVersion: 2 }],
  ]) {
    await writeFile(path, JSON.stringify(value));
    await reject();
    await writeFile(path, JSON.stringify(f.manifests.get(path)));
  }
  const alias = join(f.root, 'metadata-alias');
  await writeFile(alias, JSON.stringify(f.manifests.get(manifestPaths[2])));
  await rm(manifestPaths[2]); await symlink(alias, manifestPaths[2]);
  await reject();
  await rm(manifestPaths[2]); await writeFile(manifestPaths[2], JSON.stringify(f.manifests.get(manifestPaths[2])));
  await rm(f.native); await symlink(process.execPath, f.native);
  await reject();
  const nativeCopy = join(f.root, 'native-copy'); await copyFile(process.execPath, nativeCopy);
  await rm(f.native); await link(nativeCopy, f.native);
  await reject();
  await rm(f.native); await writeFile(f.native, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await reject();
  await copyFile(process.execPath, f.native);
  await rm(f.wrapper); await symlink('/usr/bin/true', f.wrapper);
  // A package metadata file cannot turn an unrelated entrypoint into a launcher.
  const launch = await prepareAuditStartup({ profile: { home: f.home, executable: f.wrapper }, directory: join(f.root, 'ordinary-binary'),
    args: ['app-server'], commandSandbox: true });
  assert.notEqual(launch.args[2], f.native);
});
