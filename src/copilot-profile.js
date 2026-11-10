import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, readdir, realpath } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createEnvironmentBinding } from './client-contracts.js';

export const COPILOT_SDK_VERSION = '1.0.29';
const ambientOverride = /^(?:COPILOT_(?:HOME|CACHE_HOME|CONFIG_DIR|CLI_PATH|DISABLE_KEYTAR|NO_AUTO_LOGIN|.*TOKEN.*|PROVIDERS_CONFIG|PROVIDER_.*)|GH_(?:TOKEN|ENTERPRISE_TOKEN|HOST|CONFIG_DIR)|GITHUB_(?:TOKEN|ENTERPRISE_TOKEN)|XDG_(?:CONFIG|DATA|STATE|CACHE)_HOME|NODE_OPTIONS|NODE_PATH)$/;
export const isCopilotNativeAuthType = value => value === 'gh-cli' || value === 'user';
export const COPILOT_SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const copilotId = value => typeof value === 'string' && !!value.trim() && value.length <= 1024 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);

export function assertCopilotEnvironment(env, native = userInfo()) {
  if (!env || env.HOME !== native.homedir || env.USER !== native.username || env.LOGNAME !== native.username)
    throw new Error('Copilot requires the native HOME, USER and LOGNAME.');
  const keys = Object.keys(env).filter(key => ambientOverride.test(key));
  if (keys.length) throw new Error(`Remove ambient Copilot authentication, provider or root overrides: ${keys.join(', ')}.`);
}

export function copilotBinding(profile, workspace) {
  const binding = createEnvironmentBinding(profile?.environmentBinding);
  if (binding.client !== 'copilot' || binding.surface !== 'cli' || binding.executionLocation !== 'local'
    || binding.profileId !== profile.profileId || binding.workspace !== workspace
    || binding.roots.config !== profile.home || binding.roots.user !== profile.userHome
    || binding.roots.reservation !== profile.reservationRoot || binding.rootMode !== profile.rootMode
    || binding.executable.path !== profile.executable || binding.executable.identity !== profile.executableIdentity
    || binding.settingsIdentity?.digest !== profile.settingsIdentity?.digest)
    throw new Error('Copilot execution does not match the selected profile binding.');
  if (binding.rootMode === 'implicit' && (binding.roots.config !== join(binding.roots.user, '.copilot') || binding.profileId !== 'default-copilot'))
    throw new Error('Invalid implicit Copilot root.');
  return binding;
}

export async function assertCopilotRoots(binding) {
  const { config, reservation, user } = binding.roots;
  if (user !== userInfo().homedir) throw new Error('Copilot requires the native user root.');
  const nested = relative(reservation, config);
  if (binding.rootMode === 'explicit' && (!nested || nested === '..' || nested.startsWith('../') || isAbsolute(nested)))
    throw new Error('Managed Copilot configuration must belong to the selected reservation root.');
  for (const path of new Set([config, reservation])) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.uid !== process.getuid() || stat.mode & (binding.rootMode === 'explicit' ? 0o077 : 0o022) || await realpath(path) !== path)
      throw new Error('Unsafe Copilot profile root.');
  }
  if (!binding.workspace || await realpath(binding.workspace) !== binding.workspace
    || !(await lstat(binding.workspace)).isDirectory()) throw new Error('Unsafe Copilot workspace.');
}

export async function resolveCopilotExecutable(env) {
  assertCopilotEnvironment(env);
  for (const folder of (env.PATH ?? '').split(':').filter(value => isAbsolute(value) && resolve(value) === value)) {
    try {
      const executable = await realpath(join(folder, 'copilot'));
      const stat = await lstat(executable);
      if (!stat.isFile() || stat.mode & 0o022) continue;
      await access(executable, constants.X_OK);
      return executable;
    } catch { /* Continue through the selected user's absolute PATH entries. */ }
  }
  throw new Error('The selected native PATH does not contain an executable Copilot CLI.');
}

export const copilotExecutableIdentity = stat => JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);

export function qualifiedCopilotRoute(binding, qualification) {
  return qualification?.rootMode === binding.rootMode && isCopilotNativeAuthType(qualification.authType)
    && qualification.executableIdentity === binding.executable.identity && qualification.sdk === COPILOT_SDK_VERSION
    && ['shared', 'per-root'].includes(qualification.scope) && copilotId(qualification.runtimeVersion);
}

export function copilotAuth(auth, binding, accountQualification, runtimeVersion) {
  if (auth?.isAuthenticated !== true) throw new Error('Copilot is signed out in the selected profile context.');
  if (!copilotId(auth.authType) || !copilotId(auth.login) || !copilotId(auth.host))
    throw new Error('Copilot account attribution is unavailable in the selected profile context.');
  if (!accountQualification && binding.rootMode === 'implicit' && auth.authType === 'gh-cli') return { type: auth.authType };
  if (!qualifiedCopilotRoute(binding, accountQualification) || accountQualification.runtimeVersion !== runtimeVersion || auth.authType !== accountQualification.authType)
    throw new Error('Copilot account scope is unverified for the selected binding.');
  return { type: auth.authType, scope: accountQualification.scope };
}

const configSources = ['config.json', 'settings.json', 'mcp-config.json', 'instructions', 'skills', 'agents', 'hooks', 'plugins', 'copilot-instructions.md'];
const projectSources = ['AGENTS.md', 'copilot-instructions.md', '.github/copilot-instructions.md', '.github/instructions',
  '.github/skills', '.github/agents', '.github/hooks', '.github/mcp.json', '.github/allowed_models.txt',
  '.github/copilot/settings.json', '.github/copilot/settings.local.json'];
export async function copilotSettingMetadata(binding) {
  const rows = [];
  async function inspect(path, depth) {
    if (rows.length >= 4096 || depth > 16) throw new Error('Copilot settings metadata exceeds its inspection bound.');
    let stat;
    try { stat = await lstat(path); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      rows.push([path, null]);
      return;
    }
    if (stat.isSymbolicLink() || await realpath(path) !== path)
      throw new Error('Copilot settings metadata has an unsafe path.');
    rows.push([path, copilotExecutableIdentity(stat)]);
    if (stat.isDirectory()) for (const name of (await readdir(path)).sort()) await inspect(join(path, name), depth + 1);
  }
  for (const name of configSources) await inspect(join(binding.roots.config, name), 0);
  for (let cwd = binding.workspace, count = 0; cwd !== '/' && cwd !== binding.roots.user; cwd = dirname(cwd)) {
    if (++count > 32) throw new Error('Copilot workspace ancestry exceeds its inspection bound.');
    for (const name of projectSources) await inspect(join(cwd, name), 0);
  }
  return new Map(rows.map(([path, value]) => [path, JSON.stringify(value)]));
}

async function settingsIdentity(binding) {
  const rows = [...await copilotSettingMetadata(binding)].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return { algorithm: 'sha256-file-stat-metadata-v1', digest: createHash('sha256').update(JSON.stringify(rows)).digest('hex') };
}

/** Resolve the selected persisted profile after the coordinator validates its repository binding. */
export async function resolveCopilotProfile({ selected, stored = selected, repository, workspace,
  terminalEnvironment = process.env, defaultUserHome = userInfo().homedir, sessionOnly = false,
  bindingRepository, accountQualification } = {}) {
  assertCopilotEnvironment(process.env);
  assertCopilotEnvironment(terminalEnvironment);
  const userHome = userInfo().homedir;
  if (defaultUserHome !== userHome) throw new Error('Copilot requires the native user home.');
  const managed = stored != null;
  if (!workspace) {
    const chosen = sessionOnly ? userHome : repository ?? stored?.repositories?.[0]?.path;
    if (!chosen) throw new Error('Select a workspace for Copilot CLI.');
    workspace = await realpath(chosen);
    if (!sessionOnly && managed && !stored.repositories?.some(row => row.path === workspace))
      throw Object.assign(new Error('The selected repository is not already bound to this profile'), { code: 'profile-repository-unbound' });
    bindingRepository = sessionOnly ? null : workspace;
  }
  if (managed && (stored.client !== 'copilot' || !copilotId(stored.id)
    || stored.native?.rootMode !== 'explicit' || !stored.native?.configRoot || !stored.native?.root))
    throw new Error('Select a persisted Copilot profile with an explicit canonical root.');
  const home = managed ? stored.native.configRoot : join(userHome, '.copilot');
  const reservationRoot = managed ? stored.native.root : home;
  const executable = managed ? stored.native.executable : await resolveCopilotExecutable(terminalEnvironment);
  if (!isAbsolute(executable ?? '') || await realpath(executable) !== executable)
    throw new Error('Select the canonical installed Copilot CLI executable.');
  const stat = await lstat(executable);
  if (!stat.isFile() || stat.mode & 0o022) throw new Error('Unsafe installed Copilot CLI executable.');
  await access(executable, constants.X_OK);
  const executableIdentity = copilotExecutableIdentity(stat);
  if (managed && stored.native.executableIdentity !== undefined && stored.native.executableIdentity !== executableIdentity)
    throw new Error('The bound Copilot executable has changed.');
  const profileId = managed ? stored.id : 'default-copilot';
  const rootMode = managed ? 'explicit' : 'implicit';
  const environmentBinding = createEnvironmentBinding({
    client: 'copilot', surface: 'cli', executionLocation: 'local', profileId, rootMode,
    roots: { config: home, reservation: reservationRoot, runtime: managed ? home : null, user: userHome },
    workspace, executable: { path: executable, identity: executableIdentity, version: stored?.native.version ?? null }, settingsIdentity: null,
  });
  await assertCopilotRoots(environmentBinding);
  environmentBinding.settingsIdentity = await settingsIdentity(environmentBinding);
  const env = { PATH: terminalEnvironment.PATH ?? '/usr/bin:/bin', HOME: userHome,
    USER: terminalEnvironment.USER, LOGNAME: terminalEnvironment.LOGNAME };
  return { client: 'copilot', surface: 'cli', executionLocation: 'local', executionMode: 'profile',
    profileId, profileName: managed ? stored.name : 'Default', environmentId: stored?.native.environmentId ?? null,
    home, userHome, nativeRoot: managed ? reservationRoot : null, reservationRoot, rootMode, bindingRepository: bindingRepository ?? null,
    cwd: workspace, executable, executableIdentity, version: environmentBinding.executable.version,
    versionSource: managed && environmentBinding.executable.version ? 'registered' : 'unavailable',
    executableSource: managed ? 'registered' : 'path', env, settingsIdentity: environmentBinding.settingsIdentity,
    environmentBinding, accountQualification };
}

/** Apply the same native profile to an independently owned disposable checkout. */
export async function rebindCopilotWorkspace(profile, workspace) {
  const previous = copilotBinding(profile, profile.cwd);
  const environmentBinding = createEnvironmentBinding({ ...previous, workspace });
  await assertCopilotRoots(environmentBinding);
  environmentBinding.settingsIdentity = await settingsIdentity(environmentBinding);
  return { ...profile, cwd: workspace, environmentBinding, settingsIdentity: environmentBinding.settingsIdentity };
}
