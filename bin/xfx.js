#!/usr/bin/env node
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { Store, renameProfile, bind, unbind, find } from '../src/profiles.js';
import { removeProfile } from '../src/profile-removal.js';
import { recoverProfileRun } from '../src/profile-recovery.js';
import { auditCommand, compareAuditProfiles } from '../src/audit.js';
import { renderAudit } from '../src/audit-report.js';
import { registerHome, unbindHome, listHomes } from '../src/homes.js';
import { launchPlan, launchHome } from '../src/launcher.js';
import { pickProfile } from '../src/picker.js';
import { findHistory, listHistory } from '../src/history.js';
import { COPY_COMPONENTS, planCopy, applyCopy, planUndo, undoCopy } from '../src/native-copy.js';
import { pickCopyComponents, confirmCopyAction } from '../src/copy-picker.js';
import { inspectProfile } from '../src/profile-inventory.js';
import { selectAdvancedCopy, reviewAdvancedConflicts } from '../src/advanced-command.js';
import { createDesktopRuntime } from '../src/desktop-runtime.js';
import { confirmClientShutdown } from '../src/client-shutdown.js';
import { createLogStorage } from '../src/log-storage.js';
import { createRamDisk } from '../src/ram-disk.js';
import { controllerLocation } from '../src/storage-location.js';
import { profileCommand } from '../src/profile-command.js';
import { createInstallation } from '../src/installation.js';
import { installationCommand, restoreHomeLogs } from '../src/installation-command.js';
import { readLogSettings } from '../src/log-storage.js';
import { desktopInstancePlan, openDesktopInstance, focusDesktopInstance, closeDesktopInstance,
  recoverDesktopInstance, listDesktopInstances, prepareDesktopInstance } from '../src/desktop-instances.js';

// Preserve JSON values while escaping terminal C1 controls in native metadata.
const displayJSON = value => JSON.stringify(value, null, 2).replace(/[\x7f-\x9f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

const help = `xfx — Xenoflux Codex profile manager

Usage: xfx [--store DIRECTORY] [--json] COMMAND
  profile create NAME [--apply]           Preview and guide a new native profile
    [--description TEXT] [--base DIRECTORY] [--from PROFILE --include config,instructions,agents]
    [--codex EXECUTABLE --codex-version VERSION] [--advanced]
  profile signin NAME [--apply]           Continue native sign-in for a prepared profile
  profile recover NAME [--apply]          Preview or reconcile a stopped, interrupted profile run
  profile register NAME ROOT --codex EXECUTABLE --codex-version VERSION
  profile list | profile inspect NAME     List profiles or inspect contents, origins and log status
  profile rename NAME NEW_NAME | profile delete NAME
  profile bind NAME REPOSITORY
  profile unbind NAME [REPOSITORY]        Remove the native binding, or only the supplied repository binding
  audit profiles LEFT RIGHT [--repo DIRECTORY] [--client cli|desktop]
  audit show --profile NAME --id TASK_ID | audit show REPORT.json
  audit diff --left-profile NAME --left-id TASK_ID --right-profile NAME --right-id TASK_ID
    [--same-task LABEL] [--variables LABEL,LABEL] [--expect-model MODEL --expect-effort EFFORT]
  audit diff LEFT_REPORT.json RIGHT_REPORT.json
  audit run --spec EXPERIMENT.json [--dry-run]
  audit cohort --spec COHORT.json         Compare selected repeated sessions or frozen run pairs
  audit show EXPERIMENT_UUID | audit diff RUN_A_UUID RUN_B_UUID
  audit resume SERIES_UUID                Continue only unstarted frozen trial slots
  audit evaluate UUID|REPORT.json [--spec REVIEWS.json]  Save a review packet or reviewed revision
  audit recover EXPERIMENT_UUID [--apply]  Reconcile interruption without restarting tasks
  audit clean EXPERIMENT_UUID [--apply]    Remove verified inactive owned checkouts
  audit export [UUID | REPORT.json | profiles LEFT RIGHT | native selection flags]
    --output FILE [--format json|markdown]  Freeze observed evidence without copying native transcripts
    [--include-content]                   Include redacted source text in a profile setup export
  copy SOURCE TARGET [--include config,instructions,agents] [--apply]
    [--advanced]                          Search and select individual items
  copy undo COPY_ID [--apply]             Preview or undo a settings copy
  launch NAME [--repo DIRECTORY] [--dry-run]
  resume NAME TASK_ID [--dry-run]
  history [--profile NAME] [--search TEXT] [--limit COUNT] [--archived]
  history --profile NAME --id TASK_ID [--turns]
                                        Look up a task, optionally its native turn metadata
  pick [--repo DIRECTORY] [--dry-run]
  desktop prepare NAME [--dry-run]       Prepare or refresh a stopped profile app
  desktop refresh NAME [--dry-run]       Alias for desktop prepare
  desktop open NAME [--dry-run]          Prepare as needed, then open or focus
  desktop list [--observe] | desktop focus NAME | desktop close NAME
  desktop recover NAME [--dry-run]       Release a stopped named instance's reservation
  install [--background-path PATH] | uninstall
  ramlogs enable [--background-path PATH] | ramlogs disable
  ramlogs ensure | ramlogs status | ramlogs inspect NAME
  ramlogs recover [--background-path PATH]  (archive old RAM logs, then enable)
  ramlogs restore-home HOME --key KEY

Store: --store, XFX_HOME, or ~/.xfx/controller.
Audit discovery is independent of copy support; availability and observed use remain separate.
Audit reports retain incomplete native evidence; hidden activity and effective configuration remain unverified.
All copy modes preserve unselected settings and destination-only items; selected skill packages are replaced exactly.
Default remains at Codex's standard paths; named profiles use isolated homes under the Xenoflux profile store. Native sign-in never clones credentials or history.
--close-clients permits graceful shutdown for copy --apply or profile create/signin --apply.
Mutation prompts and external-terminal checks still apply. Read-only operations never quit applications.
`;
const argv = process.argv.slice(2);
const options = {}, args = [];
let json = false;
let bootstrapReplied = false;
try {
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === '--json') { json = true; continue; }
    if (value === '--help' || value === '-h') { options.help = true; continue; }
    if (['--dry-run', '--archived', '--observe', '--apply', '--close-clients', '--advanced', '--turns', '--include-content'].includes(value)) { options[value] = true; continue; }
    if (value.startsWith('--')) {
      const equals = value.indexOf('=');
      const flag = equals < 0 ? value : value.slice(0, equals);
      if (!['--store', '--description', '--repo', '--base', '--from', '--codex', '--codex-version', '--profile', '--id', '--search', '--limit', '--include', '--background-path', '--key', '--expect-model', '--expect-effort', '--same-task', '--variables', '--left-profile', '--left-id', '--right-profile', '--right-id', '--client', '--output', '--format', '--spec'].includes(flag)) throw new Error(`Unknown option: ${flag}`);
      if (options[flag] !== undefined) throw new Error(`Repeated option: ${flag}`);
      if (equals < 0 && (argv[i + 1] === undefined || argv[i + 1].startsWith('--'))) throw new Error(`Missing value for ${flag}`);
      const argument = equals < 0 ? argv[++i] : value.slice(equals + 1);
      options[flag] = argument;
    } else args.push(value);
  }
  if (options.help || !args.length) { process.stdout.write(help); }
  else {
    const [command, ...params] = args;
    const arity = { copy: 2, launch: 1, resume: 2, history: 0, pick: 0, install: 0, uninstall: 0 };
    const grouped = ['profile', 'desktop', 'ramlogs', 'audit'].includes(command);
    if (!grouped && !Object.hasOwn(arity, command)) throw new Error(`Unknown command: ${command}`);
    if (!grouped && params.length !== arity[command]) throw new Error(`Invalid arguments for ${command}; run xfx --help`);
    const installing = ['install', 'uninstall'].includes(command) || (command === 'ramlogs' && ['enable', 'disable', 'restore-home', 'recover'].includes(params[0]));
    const settingUp = command === 'profile' && ['create', 'signin'].includes(params[0]);
    const recoveringProfile = command === 'profile' && params[0] === 'recover';
    const allowedOptions = {
      '--background-path': command === 'install' || (command === 'ramlogs' && ['enable', 'recover'].includes(params[0])),
      '--key': command === 'ramlogs' && params[0] === 'restore-home',
      '--description': settingUp && params[0] === 'create',
      '--repo': ['launch', 'pick', 'audit'].includes(command),
      '--base': settingUp && params[0] === 'create', '--from': settingUp && params[0] === 'create',
      '--codex': command === 'profile' && ['register', 'create'].includes(params[0]),
      '--codex-version': command === 'profile' && ['register', 'create'].includes(params[0]),
      '--advanced': (command === 'copy' && params[0] !== 'undo') || (settingUp && params[0] === 'create'),
      '--include': (command === 'copy' && params[0] !== 'undo') || (settingUp && params[0] === 'create'),
      '--apply': command === 'copy' || settingUp || recoveringProfile || (command === 'audit' && ['recover', 'clean'].includes(params[0])),
      '--dry-run': ['launch', 'resume', 'pick', 'copy'].includes(command) || settingUp
        || (command === 'desktop' && (['open', 'prepare', 'refresh'].includes(params[0])
          || (params[0] === 'recover' && params.length === 2))) || (command === 'audit' && params[0] === 'run'),
      '--observe': command === 'desktop' && params[0] === 'list',
      '--close-clients': !options['--dry-run'] && ((command === 'copy' && options['--apply'])
        || installing || (settingUp && options['--apply'])),
      '--profile': ['history', 'audit'].includes(command), '--id': ['history', 'audit'].includes(command), '--search': command === 'history', '--limit': command === 'history', '--archived': command === 'history',
      '--turns': command === 'history',
      '--expect-model': command === 'audit', '--expect-effort': command === 'audit',
      '--same-task': command === 'audit', '--variables': command === 'audit',
      '--include-content': command === 'audit' && params[0] === 'export',
      '--left-profile': command === 'audit', '--left-id': command === 'audit',
      '--right-profile': command === 'audit', '--right-id': command === 'audit',
      '--client': command === 'audit', '--format': command === 'audit', '--output': command === 'audit',
      '--spec': command === 'audit' && ['run', 'cohort', 'evaluate'].includes(params[0]),
    };
    for (const [flag, allowed] of Object.entries(allowedOptions)) {
      if (options[flag] !== undefined && !allowed) throw new Error(`${flag} is not supported by ${command}`);
    }
    const store = new Store(await controllerLocation(options['--store']));
    const progress = message => process.stdout.write(message.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ') + '\n');
    const clientRuntime = signal => createDesktopRuntime({ closeClients: options['--close-clients'] ?? false,
      confirmCloseClients: apps => confirmClientShutdown(apps, { signal }), signal, onProgress: progress });
    let result;
    if (installing) {
      if (!process.stdin.isTTY || !process.stdout.isTTY || json) throw new Error('Installation and log-routing changes require an external interactive terminal');
      if (command === 'ramlogs' && params.length !== (params[0] === 'restore-home' ? 2 : 1)) throw new Error('Invalid ramlogs command; run xfx --help');
      if (params[0] === 'restore-home' && !options['--key']) throw new Error('--key is required for restore-home');
      const controller = new AbortController(), abort = () => controller.abort();
      const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGTSTP'];
      for (const signal of signals) process.on(signal, abort);
      try {
        const control = { runtime: clientRuntime(controller.signal), signal: controller.signal, backgroundPath: options['--background-path'] };
        result = params[0] === 'restore-home'
          ? await restoreHomeLogs(resolve(params[1]), options['--key'], control)
          : await installationCommand(store, command === 'ramlogs' ? params[0] : command, control);
      } finally { for (const signal of signals) process.off(signal, abort); }
    } else if (command === 'ramlogs') {
      const [operation, profile] = params;
      if (params.length !== ({ ensure: 1, status: 1, inspect: 2 })[operation]) throw new Error('Invalid ramlogs command; run xfx --help');
      if (operation === 'ensure') {
        const settings = readLogSettings();
        result = { status: settings.enabled ? 'ready' : 'disabled', path: await createLogStorage().ensureMounted(), persistent: false };
      } else if (operation === 'status') result = { ...await createInstallation().status(), volume: await createRamDisk().inspect() };
      else {
        const plan = await launchPlan(store, profile);
        result = await createLogStorage().inspect({ home: plan.home, key: plan.environmentId });
      }
    } else if (command === 'copy') {
      const [source, target] = params;
      const undo = source === 'undo';
      if (undo && options['--include'] !== undefined) throw new Error('--include is not supported by copy undo');
      if (options['--apply'] && options['--dry-run']) throw new Error('--apply cannot be combined with --dry-run');
      if (options['--apply'] && (!process.stdin.isTTY || !process.stdout.isTTY || json))
        throw new Error('Copy changes require an external interactive terminal; preview with --include and --json first');
      if (options['--advanced'] && options['--include'] !== undefined) throw new Error('--advanced cannot be combined with --include');
      if (options['--advanced'] && (json || !process.stdin.isTTY || !process.stdout.isTTY))
        throw new Error('Advanced selection requires an interactive terminal; use profile inspect NAME --json for inventory');
      let include, selection, setupGuidance = [], limitations = [];
      if (options['--advanced']) {
        const picked = await selectAdvancedCopy(store, source, target);
        if (!picked) { result = { status: 'cancelled' }; process.exitCode = 130; }
        else {
          selection = Array.isArray(picked) ? picked : picked.selection;
          setupGuidance = Array.isArray(picked) ? [] : picked.setup ?? [];
          limitations = Array.isArray(picked) ? [] : picked.limitations ?? [];
        }
      } else if (!undo) {
        if (options['--include'] !== undefined) {
          include = options['--include'].split(',').map(value => value.trim());
          if (!include.length || include.some(value => !COPY_COMPONENTS.includes(value)) || new Set(include).size !== include.length)
            throw new Error(`--include must name one or more of: ${COPY_COMPONENTS.join(', ')}`);
        } else {
          if (!process.stdin.isTTY || !process.stdout.isTTY || json)
            throw new Error(`--include is required outside an interactive terminal; choose from: ${COPY_COMPONENTS.join(', ')}`);
          include = await pickCopyComponents(COPY_COMPONENTS);
          if (include === null) { result = { status: 'cancelled' }; process.exitCode = 130; }
        }
      }
      if (!result) {
        let copyOptions = { ...(selection ? { selection } : { include }), defaultUserHome: homedir() };
        let preview = undo ? await planUndo(store, target, copyOptions) : await planCopy(store, source, target, copyOptions);
        let skipped = [];
        if (options['--apply'] && !undo && preview.items?.some(item => item.status === 'conflict')) {
          const ids = preview.items.map(item => item.id).filter(Boolean);
          const reviewed = await reviewAdvancedConflicts(preview, ids);
          if (!reviewed) { result = { status: 'cancelled' }; process.exitCode = 130; }
          else {
            skipped = reviewed.skipped;
            copyOptions = { selection: reviewed.selection, defaultUserHome: copyOptions.defaultUserHome };
            if (reviewed.selection.length) {
              const priorComponents = preview.components;
              preview = await planCopy(store, source, target, copyOptions);
              if (priorComponents) preview.components = priorComponents;
            } else preview = { ...preview, status: 'unchanged', items: [], changes: [], hash: undefined };
            preview.skipped = skipped;
          }
        }
        if (result) { /* conflict review was cancelled */ }
        else {
        const review = { ...preview, ...(options['--advanced'] ? { setup: setupGuidance, limitations } : {}), skipped };
        const hasWrites = (preview.changes ?? []).some(change => change.action !== 'identical')
          || (preview.items ?? []).some(item => !['identical', 'unchanged', 'skipped', 'kept'].includes(item.status));
        if (!options['--apply'] || (options['--apply'] && !undo && !hasWrites)) result = options['--apply'] && !undo ? { ...review, status: 'unchanged' } : review;
        else {
          const controller = new AbortController(), abort = () => controller.abort();
          const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGTSTP'];
          for (const signal of signals) process.on(signal, abort);
          try {
            process.stdout.write(`${displayJSON(review)}\n`);
            process.stdout.write('Applying a copy may require a graceful client shutdown; standalone terminal Codex sessions must be closed manually.\n');
            const action = undo ? 'undo' : 'copy';
            if (!await confirmCopyAction(action, { signal: controller.signal })) { result = { status: 'cancelled' }; process.exitCode = 130; }
            else {
              const mutationOptions = { expectedHash: preview.hash, defaultUserHome: copyOptions.defaultUserHome,
                runtime: clientRuntime(controller.signal), signal: controller.signal };
              result = undo ? await undoCopy(store, target, mutationOptions)
                : await applyCopy(store, source, target, { ...copyOptions, ...mutationOptions });
              if (!undo) result = { ...result, skipped, ...(options['--advanced'] ? { setup: setupGuidance, limitations } : {}) };
            }
          } finally { for (const signal of signals) process.off(signal, abort); }
        }
        }
      }
    } else if (command === 'desktop') {
      const [operation, ...targets] = params;
      const counts = { recover: [1], prepare: [1], refresh: [1], open: [1], focus: [1], close: [1], list: [0] };
      if (!counts[operation]?.includes(targets.length))
        throw new Error('Invalid desktop command; run xfx --help');
      if (operation === 'prepare' || operation === 'refresh') {
        if (options['--dry-run']) result = await desktopInstancePlan(store, targets[0]);
        else {
          if (!process.stdin.isTTY || !process.stdout.isTTY || json)
            throw new Error('Desktop preparation requires an external interactive terminal; preview with --dry-run first');
          await clientRuntime().assertExternal();
          result = await prepareDesktopInstance(store, targets[0]);
        }
      } else if (operation === 'open') result = options['--dry-run']
        ? await desktopInstancePlan(store, targets[0]) : await openDesktopInstance(store, targets[0], {
          onBootstrapReady: async reply => {
            // The Finder bootstrap is waiting on this line before exec. Once
            // authorized it closes the pipe; do not write the ordinary result.
            await new Promise((resolve, reject) => process.stdout.write(`${JSON.stringify(reply)}\n`, error => error ? reject(error) : resolve()));
            bootstrapReplied = true;
          },
        });
      else if (operation === 'list') {
        result = await listDesktopInstances(store, { observe: options['--observe'] ?? false });
        if (result.instances.some(instance => instance.observed?.status === 'unavailable')) process.exitCode = 2;
      }
      else if (operation === 'focus') result = await focusDesktopInstance(store, targets[0]);
      else if (operation === 'close') result = await closeDesktopInstance(store, targets[0]);
      else if (operation === 'recover') result = options['--dry-run']
        ? { ...(await desktopInstancePlan(store, targets[0])), status: 'recovery-preview', applyChecks: 'pending', opensDesktop: false }
        : await recoverDesktopInstance(store, targets[0]);
    } else if (command === 'audit') {
      const controller = new AbortController(), abort = () => controller.abort('cancelled');
      const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
      const executes = ['run', 'resume'].includes(params[0]);
      if (executes) for (const signal of signals) process.on(signal, abort);
      try {
        const report = await auditCommand(store, params, options, { signal: controller.signal });
        result = report.value; process.exitCode = report.exitCode;
      } finally { if (executes) for (const signal of signals) process.off(signal, abort); }
    } else if (command === 'history') {
      if (options['--turns'] && options['--id'] === undefined) throw new Error('--turns requires --id and --profile');
      if (options['--id'] !== undefined) {
        if (!options['--profile']) throw new Error('--id requires --profile');
        for (const flag of ['--search', '--limit', '--archived']) {
          if (options[flag] !== undefined) throw new Error(`--id cannot be combined with ${flag}`);
        }
        result = await findHistory(store, options['--profile'], options['--id'], { turns: options['--turns'] ?? false });
        result.id = options['--id'];
        result.status = result.entry ? 'found' : result.home.status === 'ready' ? 'not-found' : 'unavailable';
        if (result.status !== 'found') process.exitCode = result.status === 'not-found' ? 1 : 2;
        else if (result.turnMetadata && result.turnMetadata.status !== 'ready') process.exitCode = 2;
      } else {
        if (options['--limit'] !== undefined && !/^[1-9]\d*$/.test(options['--limit'])) throw new Error('History limit must be a positive integer');
        result = await listHistory(store, { profile: options['--profile'], query: options['--search'],
          limit: options['--limit'] === undefined ? 50 : Number(options['--limit']), archived: options['--archived'] ?? false });
        if (result.homes.some(h => ['unavailable','partial'].includes(h.status))) process.exitCode = 2;
      }
    } else if (command === 'profile') {
      const [operation, profile, directory] = params;
      if (['create','signin'].includes(operation)) {
        result = await profileCommand(store, params, options, { json, clientRuntime });
        if (result.status === 'cancelled') process.exitCode = 130;
        else if (result.status === 'failed') process.exitCode = Number.isInteger(result.exitCode) && result.exitCode > 0 && result.exitCode < 256 ? result.exitCode : 1;
      } else if (operation === 'recover') {
        if (params.length !== 2) throw new Error('Use profile recover NAME [--apply]');
        if (options['--apply'] && (!process.stdin.isTTY || !process.stdout.isTTY || json))
          throw new Error('Profile recovery requires an external interactive terminal; omit --apply to preview');
        result = await recoverProfileRun(store, profile, { apply: options['--apply'] ?? false, runtime: clientRuntime() });
      } else {
        const counts = { register: [3], unbind: [2, 3], list: [1], inspect: [2], rename: [3], delete: [2], bind: [3] };
        if (!counts[operation]?.includes(params.length))
          throw new Error('Invalid profile command; run xfx --help');
        if (operation === 'register') result = await registerHome(store, profile, directory, { executable: options['--codex'], version: options['--codex-version'] });
        else if (operation === 'unbind') result = params.length === 2 ? await unbindHome(store, profile)
          : await store.update(data => unbind(data, profile, directory));
        else if (operation === 'list') result = await listHomes(store);
        else if (operation === 'inspect') {
          const inventory = await inspectProfile(store, profile);
          result = profile.toLowerCase() === 'default' ? { name: 'Default', home: inventory.profile.home } : await launchPlan(store, profile);
          result.inventory = inventory;
          result.logStorage = await createLogStorage().inspect({ home: result.home, key: result.environmentId ?? 'default' });
        } else if (operation === 'delete') result = await removeProfile(store, profile);
        else result = await store.update(data => {
          if (operation === 'rename') return renameProfile(data, profile, directory);
          return bind(data, profile, directory);
        });
      }
    } else if (['launch','resume','pick'].includes(command)) {
      if (command === 'pick' && json) throw new Error('The interactive picker does not support --json; use profile list');
      if ((command === 'pick' || !options['--dry-run']) && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error('Use an interactive terminal, or launch PROFILE --dry-run to inspect');
      if (command !== 'pick' && json && !options['--dry-run']) throw new Error('Native terminal output is not JSON; use --dry-run with --json');
      const controller = new AbortController(), abort = () => controller.abort();
      // A detached native group cannot receive foreground terminal signals.
      // Ctrl-Z deliberately cancels this first launcher rather than orphaning
      // a running Codex client beneath a suspended owner.
      const terminatingSignals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGTSTP'];
      for (const signal of terminatingSignals) process.on(signal, abort);
      try {
        const selected = command !== 'pick' ? params[0] : await pickProfile(await listHomes(store), {
          signal: controller.signal,
          inspect: id => launchPlan(store, id, undefined, { repository: options['--repo'] }),
          history: profile => listHistory(store, { profile }),
          async compare(leftId, rightId) {
            return compareAuditProfiles(store, leftId, rightId, { repo: options['--repo'] });
          },
        });
        const profile = typeof selected === 'object' && selected !== null ? selected.profileId : selected;
        const resumeId = command === 'resume' ? params[1] : selected?.resumeId;
        const launchOptions = { repository: options['--repo'], resumeId };
        if (profile === null) result = { status: 'cancelled' };
        else if (options['--dry-run']) result = await launchPlan(store, profile, undefined, launchOptions);
        else {
          result = await launchHome(store, profile, { ...launchOptions, signal: controller.signal, onStart(plan) {
            const name = plan.name.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
            process.stdout.write(`Opening ${name}\nHome: ${plan.home}\nWorkspace: ${plan.cwd}\nNative settings and history stay in this home.\n`);
          } });
          process.exitCode = result.status === 'exited' ? 0 : Number.isInteger(result.exitCode) && result.exitCode > 0 ? result.exitCode : 2;
        }
      } finally {
        for (const signal of terminatingSignals) process.off(signal, abort);
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
      }
    }
    if (bootstrapReplied) { /* The controller records completion after the bootstrap exec. */ }
    else if (!json && command === 'profile' && params[0] === 'list') process.stdout.write(result.length ? result.map(p => `${p.name.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')}  [${p.state}]${p.home ? `  ${p.home}` : ''}`).join('\n') + '\n' : 'No profiles. Use xfx profile create NAME.\n');
    else if (!json && command === 'audit') process.stdout.write(result.kind === 'audit-export'
      ? `Audit exported to ${result.output}\nFrozen evidence: ${result.evidencePath}\n`
      : renderAudit(result));
    else if (!json && command === 'history') {
      const display = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
      const when = value => { const d = new Date(value*1000); return Number.isFinite(d.getTime()) ? d.toISOString() : 'unknown date'; };
      if (options['--id'] !== undefined) {
        const t = result.entry, h = result.home;
        process.stdout.write(t
          ? `[${display(t.profileName)}] ${display(t.title)}\n  Task: ${display(t.id)}\n  Workspace: ${display(t.cwd)}\n  Profile: ${display(t.profileName)} (${display(t.profileId)})\n  Environment: ${display(t.environmentId ?? 'standard home')}\n  Home: ${display(t.home)}\n  Source: ${display(t.source)}\n  Archived: ${t.archived ? 'yes' : 'no'}\n  Updated: ${when(t.updatedAt)}\n`
          : result.status === 'not-found'
            ? `Task ${display(result.id)} not found in profile ${display(h.profileName)} (${display(h.profileId)}).\n`
            : `History ${display(h.status)} for profile ${display(h.profileName)} (${display(h.profileId)}); cannot look up task ${display(result.id)}.\n${display(h.reason)}\n`);
        if (result.turnMetadata) {
          const m = result.turnMetadata, known = value => display(value ?? 'unknown');
          process.stdout.write(`Turn metadata: ${display(m.status)}\n  Source: ${display(m.source)}\n  Rollout: ${known(m.rolloutPath)}\n  Native client: ${known(m.originator)} · ${known(m.clientVersion)}\n`);
          if (m.parentTaskId) process.stdout.write(`  Parent task: ${display(m.parentTaskId)} · Unattributed turns excluded: ${m.unattributedTurnCount}\n`);
          if (m.reason) process.stdout.write(`  ${display(m.reason)}\n`);
          for (const turn of result.turns) {
            process.stdout.write(`  ${display(turn.turnId)} · ${known(turn.recordedAt)} · line ${turn.sourceLine}\n    Workspace: ${known(turn.cwd)}\n    Roots: ${turn.workspaceRoots ? turn.workspaceRoots.map(display).join(', ') || '(none)' : 'unknown'}\n    Model: ${known(turn.model)} · Effort: ${known(turn.reasoningEffort)}\n`);
            for (const issue of turn.issues) process.stdout.write(`    ${display(issue)}\n`);
          }
        }
      } else {
        process.stdout.write(result.entries.length ? result.entries.map(t => `[${display(t.profileName)}] ${display(t.title)}\n  ${display(t.id)} · ${when(t.updatedAt)}\n  ${display(t.cwd)}`).join('\n')+'\n' : 'No saved tasks.\n');
        for (const h of result.homes.filter(h => ['unavailable','partial'].includes(h.status))) process.stderr.write(`History ${h.status} for ${display(h.profileName)}.\n`);
        if (result.truncated) process.stdout.write('More tasks are available; narrow --search or increase --limit.\n');
      }
    }
    else if (!json && ['launch','resume','pick'].includes(command) && result.reportPath) process.stdout.write(`Codex ${result.status}${result.error ? ` (${result.error})` : ''}.\nLaunch record: ${result.reportPath}\n`);
    else process.stdout.write(`${displayJSON(result)}\n`);
  }
} catch (error) {
  const message = args[0] === 'audit'
    ? error.message.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ') : error.message;
  process.stderr.write(json ? `${JSON.stringify({ error: message })}\n` : `xfx: ${message}\n`);
  process.exitCode = error.code === 'CANCELLED' || error.name === 'AbortError' ? 130 : 1;
}
