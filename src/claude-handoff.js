import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, opendir, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exists, privateDirectory, readJSON } from './metadata.js';

const ownerTimeout = 45000;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const resumeUrl = /^claude:\/\/resume\?session=(.+)$/;
const resumeRoute = /^claude(?:-dev)?:\/\/resume(?:[:/?#]|$)/i;
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

export async function readClaudeDesktopSessionRecords(desktopData, sessionId, cwd) {
  if (!uuid.test(sessionId) || typeof cwd !== 'string') throw new Error('Invalid Claude session reference');
  const directories = [join(desktopData, 'claude-code-sessions')];
  if (!await exists(directories[0])) return [];
  const session = `local_${sessionId}`, records = [];
  let inspected = 0;
  for (let depth = 0; depth < 2; depth++) {
    for (const directory of directories.splice(0)) {
      await privateDirectory(directory);
      for await (const entry of await opendir(directory)) {
        if (++inspected > 256) throw new Error('Claude Desktop session storage is too large to verify');
        if (entry.isDirectory() && uuid.test(entry.name)) directories.push(join(directory, entry.name));
      }
    }
  }
  for (const directory of directories) {
    await privateDirectory(directory);
    const path = join(directory, `${session}.json`);
    if (!await exists(path)) continue;
    const saved = await readJSON(path).catch(error => {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    });
    if (saved?.sessionId === session && saved.cliSessionId === sessionId && saved.cwd === cwd
      && saved.fromCliTranscript === true && saved.isArchived !== true && Number.isSafeInteger(saved.createdAt))
      records.push({ path, createdAt: saved.createdAt, lastFocusedAt: Number.isSafeInteger(saved.lastFocusedAt) ? saved.lastFocusedAt : 0 });
  }
  return records;
}

export async function serveClaudeHandoff(handoff) {
  // Darwin's Unix socket path is limited to 103 bytes.
  const directory = await mkdtemp('/private/tmp/xfx-claude-app-');
  const path = join(directory, 'handoff.sock'), token = randomUUID();
  const sockets = new Set();
  let active, accepted = false, closing = false;
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setTimeout(ownerTimeout, () => socket.destroy());
    let request = '';
    socket.on('data', chunk => {
      request += chunk;
      if (request.length > 100) return socket.destroy();
      if (!request.includes('\n')) return;
      socket.pause();
      const [key, sessionId] = request.slice(0, -1).split(' ');
      if (closing || active || accepted || request !== `${token} ${sessionId}\n` ||
        key !== token || !uuid.test(sessionId ?? ''))
        return socket.end('refused\n');
      active = (async () => {
        try {
          await handoff(sessionId, () => !closing && !socket.destroyed);
          accepted = true;
          socket.end('accepted\n');
        } catch {
          socket.end('refused\n');
        } finally {
          active = undefined;
        }
      })();
    });
  });
  try {
    const script = fileURLToPath(import.meta.url);
    await writeFile(join(directory, 'open'),
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} ${quote(path)} ${quote(token)} "$@"\n`,
      { flag: 'wx', mode: 0o700 });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, resolve);
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    directory,
    get accepted() { return accepted; },
    async close() {
      closing = true;
      for (const socket of sockets) socket.destroy();
      await Promise.all([active, new Promise(resolve => server.close(resolve))]);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function openFromClaude(path, token, args) {
  if (!args.some(arg => resumeRoute.test(arg))) {
    const result = spawnSync('/usr/bin/open', args, { stdio: 'inherit' });
    return result.status ?? 1;
  }
  const sessionId = args.length === 1 ? resumeUrl.exec(args[0])?.[1].toLowerCase() : undefined;
  if (uuid.test(sessionId ?? '')) {
    const accepted = await new Promise(resolve => {
      const socket = createConnection(path);
      let reply = '';
      socket.setTimeout(ownerTimeout, () => socket.destroy());
      socket.on('connect', () => socket.write(`${token} ${sessionId}\n`));
      socket.on('data', chunk => {
        reply += chunk;
        if (reply.length > 9) socket.destroy();
      });
      socket.on('error', () => socket.destroy());
      socket.on('close', hadError => resolve(!hadError && reply === 'accepted\n'));
    });
    if (accepted) return 0;
  }
  console.error('Xenoflux could not confirm the handoff. Check this profile’s Desktop in Xenoflux. Sign in there if prompted, then retry /app.');
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = await openFromClaude(process.argv[2], process.argv[3], process.argv.slice(4));
