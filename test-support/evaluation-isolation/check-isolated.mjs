// Offline acceptance transport only. It cannot launch or authorize a model task.
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateExecutionEnvelope } from './prepare-envelope.mjs';
import { verifyAppleCandidate } from './verify-apple.mjs';

export async function checkIsolated(envelopePath, taskId, workspace = process.cwd()) {
  if (!isAbsolute(envelopePath) || !isAbsolute(workspace) || await realpath(workspace) !== workspace)
    throw new Error('isolated-check-canonical-path-required');
  // This validator requires approval=false. A future paid execution path needs
  // its own review and authorization; flipping a JSON boolean does not enable it.
  const envelope = await validateExecutionEnvelope(envelopePath);
  if (!envelope.tasks.some(task => task.id === taskId)) throw new Error('isolated-check-task-invalid');
  const runtime = envelope.workerRuntime;
  if (!runtime || !isAbsolute(runtime.path) || await realpath(runtime.path) !== runtime.path
    || (await lstat(runtime.path)).isSymbolicLink()
    || createHash('sha256').update(await readFile(runtime.path)).digest('hex') !== runtime.sha256)
    throw new Error('isolated-check-runtime-unbound-or-changed');
  const root = dirname(envelopePath), info = await lstat(root);
  if (await realpath(root) !== root || info.uid !== process.getuid() || (info.mode & 0o077))
    throw new Error('isolated-check-private-envelope-required');
  const output = join(root, `offline-check-${taskId}-${randomUUID()}`);
  const result = await verifyAppleCandidate(runtime.path, envelope.sourceCampaign.path, output, taskId, workspace);
  if (result.status !== 'verified-offline-candidate-check' || result.cleanup?.remainingIds.length
    || result.cleanup?.inventoryStatus !== 'verified' || result.registryConnections !== 0
    || !result.candidateCheck) throw new Error('isolated-check-incomplete');
  return { passed: result.candidateCheck.passed, stdout: result.candidateCheck.stdout,
    stderr: result.candidateCheck.stderr, receipt: join(output, 'verification.json'),
    candidateFingerprint: result.candidateInput.fingerprint, paidCalls: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4) throw new Error('Use check-isolated.mjs ENVELOPE.json TASK_ID');
    const result = await checkIsolated(process.argv[2], process.argv[3]);
    process.stdout.write(result.stdout); process.stderr.write(result.stderr);
    process.exitCode = result.passed ? 0 : 1;
  } catch (error) { console.error(`Isolated acceptance rejected: ${error.message}`); process.exitCode = 1; }
}
