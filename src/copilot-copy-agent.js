const integrationField = /"(?:hooks|mcpServers|mcp-servers|plugins)"\s*:|^(?:hooks|mcpServers|mcp-servers|plugins):/m;
const connectionFields = new Set(['mcp-servers', 'mcpServers', 'allowed-tools']);
const portableFields = new Set(['name', 'description', 'target', 'model', 'infer', 'user-invocable',
  'disable-model-invocation', 'argument-hint', 'color', 'metadata', 'tools']);
const toolName = /^(?:\*|[A-Za-z_][\w.-]*(?:\/(?:\*|[\w.-]+))*)$/;
const ownershipError = () => new Error('Unknown or integration-bearing Copilot agent ownership');

function toolList(value, lines) {
  const list = value.trim();
  if (lines.some(line => line.trim() && !/^ *#/.test(line))) {
    if (list && !list.startsWith('#')) throw ownershipError();
    return lines.filter(line => line.trim() && !/^ *#/.test(line)).map(line => {
      const entry = /^ *- +(.+)$/.exec(line)?.[1];
      if (!entry) throw ownershipError();
      return toolNameFrom(entry);
    });
  }
  const flow = /^\[([^\[\]]*)\](?:[ \t]+#.*)?$/.exec(list);
  if (flow) {
    const members = flow[1].trim();
    return members ? members.replace(/,$/, '').split(',').map(toolNameFrom) : [];
  }
  const scalar = list.replace(/[ \t]+#.*$/, '');
  const quoted = /^(["'])([^"']+)\1$/.exec(scalar);
  if (/^["']/.test(scalar) && !quoted) throw ownershipError();
  if (quoted?.[2] === '*') return ['*'];
  return (quoted?.[2] ?? scalar).split(',').map(toolNameFrom);
}

function toolNameFrom(value) {
  const name = value.trim().replace(/[ \t]+#.*$/, '');
  const quoted = /^(["'])([^"']+)\1$/.exec(name);
  const token = quoted?.[2] ?? name;
  if (!toolName.test(token) || !quoted && /^(?:\*|true|false|yes|no|on|off|null)$/i.test(token)) throw ownershipError();
  return token;
}

// Parse only supported top-level fields and the shapes we can keep or remove.
// Copying an ambiguous frontmatter could silently widen a tool allowlist.
export function portableCopilotAgent(text, { strip = false } = {}) {
  const opening = /^---[ \t]*\r?\n/.exec(text)?.[0];
  if (!opening) {
    if (/^\s*---(?=[\s\u0085]|$)/u.test(text) || integrationField.test(text)) throw ownershipError();
    return text;
  }
  const rest = text.slice(opening.length);
  const end = /^---[ \t]*(?:\r?\n|$)/m.exec(rest)?.index;
  if (end === undefined) throw ownershipError();
  const header = rest.slice(0, end);
  if (/\r(?!\n)|[\u0000\u0085\u2028\u2029]/u.test(header)) throw ownershipError();

  const fields = [];
  const seen = new Set();
  let current;
  for (const raw of header.match(/[^\n]*\n/g) ?? []) {
    const line = raw.replace(/\r?\n$/, '');
    if (/^(?:\s*$| *#)/.test(line) || current && /^(?: +\S|- +\S)/.test(line)) {
      if (current) current.children.push(raw);
      else fields.push({ raw, children: [] });
      continue;
    }
    const [, key, value] = /^([a-z][a-zA-Z-]*):((?:[ \t].*)?)$/.exec(line) ?? [];
    if (!key || seen.has(key) || !(portableFields.has(key) || strip && connectionFields.has(key))) throw ownershipError();
    seen.add(key);
    current = { key, value, raw, children: [] };
    fields.push(current);
  }

  const portableHeader = fields.map(({ key, value, raw, children }) => {
    if (connectionFields.has(key)) return '';
    const lines = children.map(line => line.replace(/\r?\n$/, ''));
    if (key === 'tools') {
      const tools = toolList(value, lines);
      const local = tools.filter(tool => !tool.includes('/') && !/^mcp__/i.test(tool));
      if (local.length !== tools.length) {
        if (!strip) throw ownershipError();
        return `tools: ${JSON.stringify(local)}${opening.endsWith('\r\n') ? '\r\n' : '\n'}`;
      }
    } else if (key === 'metadata') {
      const keys = new Set();
      if (value.trim() && value.trim() !== '{}') throw ownershipError();
      for (const line of lines.filter(line => line.trim() && !/^ *#/.test(line))) {
        const [, name] = /^ {2}([\w.-]+): +\S.*$/.exec(line) ?? [];
        if (!name || keys.has(name)) throw ownershipError();
        keys.add(name);
      }
    } else if (lines.some(line => line.trim() && !/^ *#/.test(line)) &&
      !(key === 'description' && /^[>|][-+]?\s*$/.test(value.trim()) && lines.every(line => !line.trim() || /^ +\S/.test(line)))) {
      throw ownershipError();
    }
    return raw + children.join('');
  }).join('');
  const result = opening + portableHeader + rest.slice(end);
  if (integrationField.test(result)) throw ownershipError();
  return result;
}
