import { access, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { find } from './profiles.js';
import { listHomes, resolveHome } from './homes.js';
import { planHomeCreation, createHome, inspectHomeCreation, startHomeSignIn } from './home-create.js';
import { COPY_COMPONENTS, planCopy, applyCopy } from './native-copy.js';
import { pickCopyComponents, confirmCopyAction } from './copy-picker.js';
import { selectAdvancedCopy, reviewAdvancedConflicts } from './advanced-command.js';
import { planActivationTarget, registerActivationTarget, readPairedPlan, preparePairedActivation } from './desktop-paired.js';
import { privateDirectory, record } from './metadata.js';
import { probeVersion } from './version-probe.js';
import { nativePath } from './node-runtime.js';

// Preserve JSON values while escaping terminal C1 controls in native metadata.
const displayJSON = value => JSON.stringify(value, null, 2).replace(/[\x7f-\x9f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

const display = value => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');

async function question(prompt, { input, output, signal }) {
  if (signal.aborted) return null;
  const lines = createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY) });
  try { return (await lines.question(prompt, { signal })).trim(); }
  catch (error) { if (signal.aborted || error.code === 'ERR_USE_AFTER_CLOSE') return null; throw error; }
  finally { lines.close(); }
}

async function nativeClient(store, options, signal) {
  let executable = options['--codex'];
  if (!executable) {
    for (const home of await listHomes(store)) {
      if (home.state !== 'ready') continue;
      executable = (await resolveHome(store, home.id)).native.executable; break;
    }
  }
  if (!executable) {
    for (const directory of (process.env.PATH ?? '').split(':').filter(isAbsolute)) {
      const candidate = join(directory, 'codex');
      try { await access(candidate, constants.X_OK); executable = candidate; break; }
      catch { /* try the next explicit PATH directory */ }
    }
  }
  if (!executable || !isAbsolute(executable)) throw new Error('Provide --codex with an absolute Codex executable path');
  executable = await realpath(executable);
  const scratch = await mkdtemp(join(await realpath(tmpdir()), 'xfx-version-'));
  let preserve = false;
  try {
    const version = await probeVersion({ executable, cwd: scratch, signal,
      env: { PATH: nativePath(), HOME: scratch, CODEX_HOME: scratch, TMPDIR: scratch } });
    if (options['--codex-version'] && options['--codex-version'] !== version) throw new Error('Codex version differs from --codex-version');
    return { executable, version };
  } catch (error) { preserve = error.code === 'SHUTDOWN_FAILED'; throw error; }
  finally { if (!preserve) await rm(scratch, { recursive: true }); }
}

/** The wizard composes existing profile, copy and activation operations. Each
 * completed step survives cancellation; no native data is cloned or removed. */
export async function profileCommand(store, params, options, { json = false, clientRuntime,
  input = process.stdin, output = process.stdout, signIn = startHomeSignIn, selectAdvanced = selectAdvancedCopy, defaultUserHome = homedir() } = {}) {
  const [operation, name] = params;
  if (params.length !== 2 || !['create', 'signin'].includes(operation)) throw new Error('Use profile create NAME or profile signin NAME');
  if (options['--apply'] && options['--dry-run']) throw new Error('--apply cannot be combined with --dry-run');
  const advanced = options['--advanced'] === true;
  if (advanced && (operation !== 'create' || options['--include'] !== undefined)) throw new Error('--advanced is only supported for creation without --include');
  if (advanced && (json || !input.isTTY || !output.isTTY)) throw new Error('Advanced selection requires an interactive terminal; use profile inspect NAME --json for inventory');
  let include = options['--include']?.split(',').map(value => value.trim());
  if (include && (!include.length || include.some(value => !COPY_COMPONENTS.includes(value)) || new Set(include).size !== include.length))
    throw new Error(`--include must name one or more of: ${COPY_COMPONENTS.join(', ')}`);
  if (include && !options['--from']) throw new Error('--include requires --from for profile creation');
  if (!advanced && options['--from'] && !include && (!options['--apply'] || json || !input.isTTY))
    throw new Error('--from requires --include outside the guided setup');
  const data = await store.read();
  const existing = data.profiles.find(profile => profile.name === name || profile.id === name);
  const base = options['--base'] ?? (existing?.native ? dirname(existing.native.root) : join(dirname(store.directory), 'profiles'));
  let preview = operation === 'create' ? await planHomeCreation({ store, name, base, description: options['--description'] })
    : await inspectHomeCreation({ store, name, base });
  preview = { ...preview, settings: { source: options['--from'] ?? null, included: include ?? [] },
    desktop: 'A reviewed activation target is required for Dock reopening.', nativeSignIn: 'Explicit native login; no credentials or history are copied.' };
  if (!options['--apply']) {
    if (!advanced) return preview;
    const source = options['--from'] ?? 'Default';
    if (source === name) throw new Error('Choose a different settings source');
    const selection = await selectAdvanced(store, source, existing?.native ? existing.id : null, { input, output, defaultUserHome });
    return selection ? { ...preview, settings: { source, selection } } : { status: 'cancelled' };
  }
  if (!input.isTTY || !output.isTTY || json) throw new Error('Profile setup requires an external interactive terminal; omit --apply to preview');
  const controller = new AbortController(), abort = () => controller.abort();
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGTSTP'];
  for (const signal of signals) process.on(signal, abort);
  const io = { input, output, signal: controller.signal }, runtime = clientRuntime(controller.signal);
  const show = value => output.write(`${displayJSON(value)}\n`);
  try {
    await runtime.assertExternal();
    let source = options['--from'] ?? (advanced ? 'Default' : undefined), setup, selection;
    if (operation === 'create') {
      if (!source && preview.profile.action !== 'resume') {
        const choice = await question('Settings: 1 minimal (recommended), 2 copy selected settings, q cancel\n> ', io);
        if (!['1', '2', ''].includes(choice)) return { status: 'cancelled' };
        if (choice === '2') {
          output.write(`Sources: Default${(await listHomes(store)).filter(home => home.state === 'ready').map(home => `, ${display(home.name)}`).join('')}\n`);
          source = await question('Source profile [Default]: ', io);
          if (source === null) return { status: 'cancelled' };
          source ||= 'Default';
        }
      }
      if (advanced) {
        selection = await selectAdvanced(store, source, existing?.native ? existing.id : null, { ...io, defaultUserHome });
        if (!selection) return { status: 'cancelled' };
      } else {
        if (source && !include) include = await pickCopyComponents(COPY_COMPONENTS, io);
        if (source && !include) return { status: 'cancelled' };
      }
      if (source === name) throw new Error('Choose a different settings source');
      // Resolve the source before preparing a target so a typo leaves no profile.
      if (source && source.toLowerCase() !== 'default') await resolveHome(store, source);
      show({ ...preview, settings: { source: source ?? null, included: include ?? [], ...(selection ? { selection } : {}) } });
      if (!await confirmCopyAction('create', io)) return { status: 'cancelled' };
      const client = await nativeClient(store, options, controller.signal);
      if (base === join(dirname(store.directory), 'profiles')) {
        await mkdir(dirname(store.directory), { recursive: true, mode: 0o700 });
        await privateDirectory(dirname(store.directory));
      }
      await mkdir(base, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      await privateDirectory(base);
      setup = await createHome({ store, name, base, description: options['--description'], ...client });
      show(setup);
      if (source) {
        let copyOptions = { ...(advanced ? { selection } : { include }), defaultUserHome };
        let copy = await planCopy(store, source, setup.profile.id, copyOptions);
        if (advanced && !existing?.native) {
          selection = await reviewAdvancedConflicts(copy, selection, io);
          if (!selection?.length) return { ...setup, status: 'setup-pending', next: 'No settings copied. Continue with profile signin or copy --advanced.' };
          copyOptions = { selection, defaultUserHome };
          copy = await planCopy(store, source, setup.profile.id, copyOptions);
        }
        show(copy);
        if (!await confirmCopyAction('copy', io)) return { ...setup, status: controller.signal.aborted ? 'cancelled' : 'setup-pending', next: 'Settings copy and native sign-in remain available as separate commands.' };
        const applied = await applyCopy(store, source, setup.profile.id, { ...copyOptions, expectedHash: copy.hash, runtime, signal: controller.signal });
        show(applied);
        setup.copy = applied;
      }
    } else setup = await inspectHomeCreation({ store, name, base });
    if (setup.login.state !== 'completed') {
      output.write('Continue with native Codex sign-in in this profile. Browser sign-in may open.\n');
      if (!await confirmCopyAction('signin', io)) return { ...setup, status: controller.signal.aborted ? 'cancelled' : 'setup-pending', next: `xfx profile signin ${JSON.stringify(name)} --apply` };
      setup = { ...setup, ...await signIn({ store, name, base, signal: controller.signal }) }; show(setup);
      if (setup.login.state === 'failed') return { ...setup, status: 'failed', exitCode: setup.native?.exitCode ?? 1 };
      if (setup.login.state === 'cancelled') return { ...setup, status: 'cancelled' };
      if (setup.login.state !== 'completed') return { ...setup, status: 'setup-pending' };
    }
    if (controller.signal.aborted) return { ...setup, status: 'cancelled' };
    let plan;
    try {
      const manifest = join(store.directory, 'activation', 'manifest.json');
      // A new profile setup needs an initial activation, existing installs only add a target.
      let current;
      try { current = await readPairedPlan(manifest, store, { defaultUserHome }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const profile = find(await store.read(), name);
      if (current?.profiles.some(item => item.profileId === profile.id)) return { ...setup, desktop: 'registered', nativeAcceptance: 'pending' };
      if (current) {
        plan = await planActivationTarget(store, name, { runtime, defaultUserHome }); show(plan);
        if (!await confirmCopyAction('register', io)) return { ...setup, status: controller.signal.aborted ? 'cancelled' : 'setup-pending', desktop: 'target-registration-pending' };
        await registerActivationTarget(store, plan, { defaultUserHome });
        return { ...setup, desktop: 'registered', nativeAcceptance: 'pending' };
      }
      plan = await preparePairedActivation(store, [name], { runtime, defaultUserHome });
      const path = join(setup.root, 'activation-plan.json'); await record(path, plan);
      return { ...setup, status: 'setup-pending', desktop: 'initial-activation-pending', activationPlan: path,
        next: `xfx desktop activate ${JSON.stringify(name)} --approved-plan ${JSON.stringify(path)}` };
    } catch (error) {
      return { ...setup, status: 'setup-pending', desktop: 'target-registration-pending', reason: error.message,
        next: `Restore Default, then rerun xfx profile create ${JSON.stringify(name)} --apply.` };
    }
  } finally {
    for (const signal of signals) process.off(signal, abort);
    if (input.isTTY && typeof input.setRawMode === 'function') input.setRawMode(false);
  }
}
