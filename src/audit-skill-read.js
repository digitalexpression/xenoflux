// Parse only a tiny, non-executing subset of shell commands used by native
// commandExecution items. Anything outside this grammar remains read intent.
function words(source) {
  if (typeof source !== 'string' || source.length > 8192 || /[\x00-\x1f\x7f]/.test(source)) return null;
  const result = [];
  let word = '', started = false, quote = null;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
      started = true;
      continue;
    }
    if (ch === '\\') {
      if (quote === '"') return null;
      if (i + 1 >= source.length || /[$`]/.test(source[i + 1])) return null;
      word += source[++i]; started = true; continue;
    }
    if (quote === '"') {
      if (ch === '"') { quote = null; started = true; continue; }
      if (ch === '$' || ch === '`') return null;
      word += ch; started = true; continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    // POSIX shell tokenization uses ASCII space and tab here. Tabs are rejected
    // by the control-character guard; Unicode whitespace remains filename data.
    if (ch === ' ') {
      if (started) { result.push(word); word = ''; started = false; }
      continue;
    }
    // Reject shell operators, expansions, globbing, comments, and syntax that
    // could make argv differ from the words we retain here.
    if (/[;&|<>$`()#~*?\[\]{}]/.test(ch)) return null;
    word += ch; started = true;
  }
  if (quote) return null;
  if (started) result.push(word);
  return result;
}

function catTarget(command, absoluteExecutableOnly = false) {
  const argv = words(command);
  if (!argv || argv.length !== 2 || !['cat', '/bin/cat', '/usr/bin/cat'].includes(argv[0]) || !argv[1] || argv[1].startsWith('-')) return null;
  if (absoluteExecutableOnly && !argv[0].startsWith('/')) return null;
  if (argv[1].split('/').includes('..')) return null;
  return argv[1];
}

export function parseLiteralSkillReadDetails(command, { absoluteExecutableOnly = false } = {}) {
  const direct = catTarget(command, absoluteExecutableOnly);
  if (direct) return { target: direct, wrapper: 'direct' };
  const argv = words(command);
  if (!argv || argv.length !== 3 || !['sh', 'bash', 'zsh', '/bin/sh', '/bin/bash', '/bin/zsh', '/usr/bin/sh', '/usr/bin/bash', '/usr/bin/zsh'].includes(argv[0])) return null;
  if (!['-c', '-lc', '-cl'].includes(argv[1])) return null;
  const target = catTarget(argv[2], absoluteExecutableOnly);
  return target ? { target, wrapper: argv[1] === '-c' ? 'shell-command' : 'login-shell-command' } : null;
}

export function parseLiteralSkillRead(command) { return parseLiteralSkillReadDetails(command)?.target ?? null; }
