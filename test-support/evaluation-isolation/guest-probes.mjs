#!/usr/bin/env node
// Guest-side isolation probes. This file intentionally uses Node built-ins only.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import dgram from 'node:dgram';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const observations = [];
const failures = [];
const add = (name, actual, expected, ok, detail = undefined) => {
  observations.push({ name, actual, expected, ok, ...(detail === undefined ? {} : { detail }) });
  if (!ok) failures.push(name);
};
const errCode = error => error?.code ?? error?.name ?? String(error);
const expectedDenied = new Set(['ENOENT', 'EACCES', 'EPERM']);
const readError = filename => {
  try { fs.readFileSync(filename); return 'READABLE'; }
  catch (error) { return errCode(error); }
};
const writeError = filename => {
  try { fs.writeFileSync(filename, 'guest-write-probe'); return 'WRITABLE'; }
  catch (error) { return errCode(error); }
};
const capture = async (name, expected, action, accepts) => {
  try {
    const actual = await action();
    add(name, actual, expected, accepts(actual));
  } catch (error) { add(name, errCode(error), expected, accepts(errCode(error))); }
};
const connectResult = (host, port, family) => new Promise(resolve => {
  let done = false;
  const socket = net.createConnection({ host, port, family });
  const finish = value => { if (done) return; done = true; socket.destroy(); resolve(value); };
  socket.setTimeout(1000, () => finish('TIMEOUT'));
  socket.once('connect', () => finish('CONNECTED'));
  socket.once('error', error => finish(errCode(error)));
});
const udpResult = () => new Promise(resolve => {
  const socket = dgram.createSocket('udp4');
  let done = false;
  const finish = value => { if (done) return; done = true; socket.close(); resolve(value); };
  const timer = setTimeout(() => finish('TIMEOUT'), 1000);
  socket.once('error', error => { clearTimeout(timer); finish(errCode(error)); });
  socket.send(Buffer.from('isolation-probe'), 9, '192.0.2.1', error => {
    if (error) { clearTimeout(timer); finish(errCode(error)); }
    // UDP send may succeed locally; without a reply this says nothing. The bounded
    // receive timeout is therefore reported as inconclusive and fails closed.
    else { clearTimeout(timer); finish('SEND_ACCEPTED'); }
  });
});

function runChild(childNode, outsideFile) {
  const childSource = String.raw`
    const fs = require('node:fs'); const os = require('node:os'); const net = require('node:net');
    const denied = new Set(['ENOENT','EACCES','EPERM']);
    let read; try { fs.readFileSync(process.argv[1]); read='READABLE'; } catch(e) { read=e.code||e.name; }
    const names=Object.keys(os.networkInterfaces()).sort();
    const network=new Promise(resolve=>{let d=false;const s=net.createConnection({host:'192.0.2.1',port:9,family:4});
      const end=x=>{if(d)return;d=true;s.destroy();resolve(x)};s.setTimeout(1000,()=>end('TIMEOUT'));
      s.once('connect',()=>end('CONNECTED'));s.once('error',e=>end(e.code||e.name));});
    network.then(code=>{ console.log(JSON.stringify({read,interfaces:names,network:code}));
      process.exit(read==='READABLE'||names.some(n=>n!=='lo')||!['ENETUNREACH','EHOSTUNREACH'].includes(code)?1:0); });
  `;
  return spawnSync(childNode, ['-e', childSource, outsideFile], {
    encoding: 'utf8', timeout: 3000, maxBuffer: 16 * 1024,
    env: process.env,
  });
}

async function main() {
  if (process.platform !== 'linux') throw new Error('probe-requires-disposable-linux-guest');
  if (process.argv.length !== 3) throw new Error('Usage: guest-probes.mjs CONFIG.json');
  const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  for (const key of ['outsideFile', 'allowedRead', 'readonlyWrite', 'hostLoopbackPort', 'outsideSocket']) {
    if (config[key] === undefined) throw new Error(`Missing config key: ${key}`);
  }
  if (!path.isAbsolute(config.outsideFile) || !path.isAbsolute(config.outsideSocket))
    throw new Error('outsideFile and outsideSocket must be absolute paths');

  add('guest_code_executed', true, true, true);
  const expectedFixtureText = config.fixtureText ?? 'fixture-canary-readable';
  let readable;
  try { readable = fs.readFileSync(config.allowedRead, 'utf8'); }
  catch (error) { readable = errCode(error); }
  add('fixture_read', readable, expectedFixtureText, readable === expectedFixtureText);

  const tmpPath = path.join('/tmp', `xfx-guest-probe-${process.pid}-${Date.now()}`);
  let tmpActual;
  try {
    fs.writeFileSync(tmpPath, 'tmp-roundtrip');
    tmpActual = fs.readFileSync(tmpPath, 'utf8') === 'tmp-roundtrip' ? 'WRITE_READ_OK' : 'CONTENT_MISMATCH';
    fs.unlinkSync(tmpPath);
    tmpActual += fs.existsSync(tmpPath) ? '_REMOVE_FAILED' : '_REMOVED';
  } catch (error) { tmpActual = errCode(error); try { fs.rmSync(tmpPath, { force: true }); } catch {} }
  add('tmp_write_read_remove', tmpActual, 'WRITE_READ_OK_REMOVED', tmpActual === 'WRITE_READ_OK_REMOVED');

  let status = '';
  try { status = fs.readFileSync('/proc/self/status', 'utf8'); } catch {}
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const gid = typeof process.getgid === 'function' ? process.getgid() : null;
  const capEff = status.match(/^CapEff:\s*([0-9a-f]+)$/mi)?.[1]?.toLowerCase() ?? null;
  const capEffIsZero = capEff !== null && /^[0-9a-f]+$/.test(capEff) && BigInt(`0x${capEff}`) === 0n;
  add('identity_capabilities', { uid, gid, capEff }, { uid: 65532, gid: 65532, capEff: 'zero' },
    uid === 65532 && gid === 65532 && capEffIsZero);

  const interfaces = Object.keys(os.networkInterfaces()).sort();
  add('network_interfaces', interfaces, ['lo'], interfaces.length === 1 && interfaces[0] === 'lo');
  let route4 = null, route6 = null;
  try { route4 = fs.readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1).filter(Boolean); }
  catch (error) { route4 = `ERROR:${errCode(error)}`; }
  try { route6 = fs.readFileSync('/proc/net/ipv6_route', 'utf8').trim().split('\n').filter(Boolean); }
  catch (error) { route6 = `ERROR:${errCode(error)}`; }
  const nonLoop4 = Array.isArray(route4) && route4.some(line => line.split(/\s+/)[0] !== 'lo');
  const nonLoop6 = Array.isArray(route6) && route6.some(line => {
    const fields = line.trim().split(/\s+/);
    return fields.length >= 10 && fields[9] !== 'lo';
  });
  add('routes', { ipv4: route4, ipv6: route6 }, 'no non-loopback IPv4 or IPv6 routes',
    Array.isArray(route4) && Array.isArray(route6) && !nonLoop4 && !nonLoop6);

  await capture('tcp_documentation_ipv4', 'ENETUNREACH or EHOSTUNREACH',
    () => connectResult('192.0.2.1', 9, 4), v => ['ENETUNREACH', 'EHOSTUNREACH'].includes(v));
  await capture('tcp_documentation_ipv6', 'ENETUNREACH or EHOSTUNREACH',
    () => connectResult('2001:db8::1', 9, 6), v => ['ENETUNREACH', 'EHOSTUNREACH'].includes(v));
  await capture('udp_documentation_ipv4', 'ENETUNREACH or EHOSTUNREACH',
    udpResult, v => ['ENETUNREACH', 'EHOSTUNREACH'].includes(v));
  await capture('host_loopback_listener', 'connection refused or network unreachable',
    () => connectResult('127.0.0.1', Number(config.hostLoopbackPort), 4),
    v => ['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH'].includes(v));

  const outside = readError(config.outsideFile);
  add('host_canary_read', outside, 'ENOENT, EACCES, or EPERM', expectedDenied.has(outside));
  const open = (() => { try { const fd = fs.openSync(config.outsideFile, 'r+'); fs.closeSync(fd); return 'OPENED'; }
    catch (error) { return errCode(error); } })();
  add('host_canary_open_readwrite', open, 'ENOENT, EACCES, or EPERM', expectedDenied.has(open));
  const linkPath = path.join('/tmp', `xfx-guest-link-${process.pid}-${Date.now()}`);
  let symlinkActual;
  try {
    fs.symlinkSync(config.outsideFile, linkPath);
    symlinkActual = readError(linkPath);
  } catch (error) { symlinkActual = `SYMLINK:${errCode(error)}`; }
  finally { try { fs.unlinkSync(linkPath); } catch {} }
  add('host_canary_via_tmp_symlink', symlinkActual, 'ENOENT, EACCES, or EPERM', expectedDenied.has(symlinkActual));

  const writeActual = writeError(config.readonlyWrite);
  add('readonly_fixture_write', writeActual, 'EROFS', writeActual === 'EROFS');
  const socketActual = await new Promise(resolve => {
    const socket = net.createConnection({ path: config.outsideSocket });
    let done = false;
    const finish = v => { if (done) return; done = true; socket.destroy(); resolve(v); };
    socket.setTimeout(1000, () => finish('TIMEOUT'));
    socket.once('connect', () => finish('CONNECTED'));
    socket.once('error', error => finish(errCode(error)));
  });
  add('host_unix_socket', socketActual, 'ENOENT', socketActual === 'ENOENT');

  const child = runChild(config.childNode ?? process.execPath, config.outsideFile);
  let childPayload;
  try { childPayload = JSON.parse(child.stdout.trim()); } catch { childPayload = child.stdout.trim(); }
  const childOkay = child.status === 0 && child.signal == null && child.error == null &&
    childPayload && expectedDenied.has(childPayload.read) &&
    Array.isArray(childPayload.interfaces) && childPayload.interfaces.length === 1 && childPayload.interfaces[0] === 'lo' &&
    ['ENETUNREACH', 'EHOSTUNREACH'].includes(childPayload.network);
  add('child_process_boundary', { status: child.status, signal: child.signal, error: child.error?.code,
    stdout: childPayload, stderr: child.stderr?.trim() },
  { hostFileDenied: true, interfaces: ['lo'], network: 'ENETUNREACH or EHOSTUNREACH' }, Boolean(childOkay));

  const permittedEnvNames = new Set([
    'PATH', 'NODE_VERSION', 'YARN_VERSION', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'HOSTNAME',
  ]);
  const unexpectedEnvNames = Object.keys(process.env).filter(name => !permittedEnvNames.has(name)).sort();
  add('sensitive_environment_names', unexpectedEnvNames, [], unexpectedEnvNames.length === 0);

  let mountLines = null;
  try { mountLines = fs.readFileSync('/proc/mounts', 'utf8').trim().split('\n'); } catch (error) { mountLines = `ERROR:${errCode(error)}`; }
  const rootMount = Array.isArray(mountLines) ? mountLines.find(line => line.split(/\s+/)[1] === '/') : null;
  const fixtureMount = Array.isArray(mountLines) ? mountLines.find(line => line.split(/\s+/)[1] === '/fixture') : null;
  const rootReadOnly = Boolean(rootMount && rootMount.split(/\s+/)[3].split(',').includes('ro'));
  const fixtureReadOnly = Boolean(fixtureMount && fixtureMount.split(/\s+/)[3].split(',').includes('ro'));
  add('mount_modes', { root: rootMount, fixture: fixtureMount }, { rootReadOnly: true, fixtureReadOnly: true },
    rootReadOnly && fixtureReadOnly);

  console.log(JSON.stringify({ version: 1, observations, failures }));
  process.exitCode = failures.length ? 1 : 0;
}

main().catch(error => {
  console.log(JSON.stringify({ version: 1, observations, failures: ['probe_startup'], startupError: errCode(error),
    message: error.message }));
  process.exitCode = 2;
});
