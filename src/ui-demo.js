// Synthetic data for `xfx ui --demo`, the U0 prototype. Nothing here reads
// or changes the user's profiles, sessions or clients; every operation is
// simulated in memory and every view says so.
import { randomUUID } from 'node:crypto';
import { UiError } from './ui-server.js';
import { ASSOCIATION, comparisonLabel, countLabels, exactStateText, groupMeta, presentComparison, presentSetupInventory } from './audit-presentation.js';
import { presentSession, presentSessionHarness } from './audit-session-presentation.js';
import { compareAuditRuns } from './audit-report.js';

const A = 'baseline', B = 'strict-review';
const SETUP_CLIENTS = { codex: 'Codex', 'claude-code': 'Claude Code', copilot: 'GitHub Copilot' };
function demoSetup(name, client, repo) {
  return presentSetupInventory({ status: 'partial', warnings: ['Synthetic setup evidence. No real files or clients are read.'],
    coverage: { config: 'complete', instructions: 'complete', agents: 'complete', rules: 'complete', skills: 'complete',
      plugins: 'partial', mcp: 'partial', hooks: 'complete', tools: 'unavailable', memorySettings: 'partial', sourceValues: 'complete' },
    resources: [
      { id: `${client}-${name}-model`, name: 'model', category: 'config', scope: 'profile', origin: 'Synthetic profile settings',
        status: 'present', path: `[DEMO]/${client}/${name}/settings`, value: client === 'codex' ? 'gpt-6' : 'native-default', valueStatus: 'present', sourceRole: 'profile' },
      { id: `${client}-${name}-instructions`, name: client === 'claude-code' ? 'CLAUDE.md' : 'AGENTS.md', category: 'instruction',
        scope: repo ? 'project' : 'profile', origin: 'Synthetic instructions', status: 'present', sourceRole: repo ? 'project' : 'profile',
        path: `${repo || `[DEMO]/${client}/${name}`}/instructions.md`, detail: { status: 'available', text: 'Review the changes and run the relevant checks.' } },
      { id: `${client}-${name}-plugin`, name: 'review-helper', category: 'plugin', scope: 'plugin', origin: 'Synthetic plugin cache',
        path: `[DEMO]/${client}/plugins/review-helper/plugin.json`, status: 'present', sourceRole: 'plugin-cache',
        value: { name: 'review-helper', version: '1.0.0' }, valueStatus: 'present',
        state: { configured: 'unknown', cached: 'present', installed: 'unknown', enabled: 'unknown', available: 'unknown', loaded: 'unknown', used: 'unknown' } },
    ] });
}
const PRECEDENCE = 'A project setting or launch option can override the profile value, so the value a session actually used isn’t known from setup alone.';

function setupItems(a, b) {
  const swap = a !== A;
  const v = (left, right) => swap ? [right, left] : [left, right];
  const side = s => swap ? (s === 'a' ? 'b' : 'a') : s;
  const st = state => !swap ? state : state === 'added' ? 'removed' : state === 'removed' ? 'added' : state;
  const values = (left, right, mono = true) => { const [x, y] = v(left, right); return [{ side: 'a', label: a, value: x, mono }, { side: 'b', label: b, value: y, mono }]; };
  const sources = rows => rows.map(([where, l, r]) => { const [x, y] = v(l, r); return { side: 'both', where, scope: 'Source', status: `${a}: ${x} · ${b}: ${y}` }; });
  const facts = rows => rows.map(([label, l, r]) => { const [x, y] = v(l, r); return { label, value: `${a}: ${x} · ${b}: ${y}` }; });
  const diff = lines => swap ? lines.map(line => ({ ...line, kind: line.kind === '-' ? '+' : line.kind === '+' ? '-' : line.kind })) : lines;
  const copy = (from, label) => ({ from, label, href: `/profiles/${encodeURIComponent(from === 'a' ? b : a)}/copy?from=${encodeURIComponent(from === 'a' ? a : b)}` });
  const item = (base) => {
    const exactState = st(base.state);
    const label = comparisonLabel(exactState);
    const actions = base.actions.copy ? { ...base.actions, copy: { ...base.actions.copy, href: `${base.actions.copy.href}&item=${encodeURIComponent(base.id)}` } } : base.actions;
    return { ...base, actions, state: undefined, exactState, label, exactText: exactStateText(exactState, { a, b }) };
  };
  const arrow = (l, r) => { const [x, y] = v(l, r); return [{ text: x, side: 'a' }, { text: ' → ' }, { text: y, side: 'b' }]; };
  const plain = text => [{ text }];
  return [
    { id: 'settings', label: 'Settings', hiddenSame: 14, items: [
      item({ id: 'effort', name: 'model_reasoning_effort', category: 'Settings', scope: 'Profile config.toml', state: 'changed', summary: arrow('medium', 'high'),
        detail: { values: values('medium', 'high'), note: 'The two profiles ask for different reasoning effort. Whether a session used it is shown in task comparisons when recorded.',
          sources: sources([['Profile config.toml', 'medium', 'high'], ['Project config', 'Not set', 'Not set'], ['Launch options', 'Not known', 'Not known']]),
          facts: [...facts([['Value a session used', 'Not known', 'Not known']]), { label: 'Which value wins', value: PRECEDENCE }] },
        actions: { copy: copy('b', `Copy from ${b} into ${a}…`) } }),
      item({ id: 'approval', name: 'approval_policy', category: 'Settings', scope: 'Profile config.toml', state: 'changed', summary: arrow('on-request', 'untrusted'),
        detail: { values: values('on-request', 'untrusted'), note: 'This is the policy setting, not permissions already granted. Granted approvals are never compared or copied.',
          sources: sources([['Profile config.toml', 'on-request', 'untrusted'], ['Project config', 'Not set', 'Not set']]),
          facts: [...facts([['Approvals already granted', 'Not compared', 'Not compared']]), { label: 'Which value wins', value: PRECEDENCE }] },
        actions: { copy: copy('b', `Copy from ${b} into ${a}…`) } }),
      item({ id: 'sandbox', name: 'sandbox_mode', category: 'Settings', scope: 'Profile config.toml', state: 'identical', summary: plain('workspace-write'),
        detail: { values: values('workspace-write', 'workspace-write'), note: 'Both profiles ask for the same value.', sources: [], facts: facts([['Value a session used', 'Not known', 'Not known']]) }, actions: {} }),
    ] },
    { id: 'instructions', label: 'Instructions', hiddenSame: 1, items: [
      item({ id: 'agents', name: 'AGENTS.md', category: 'Instructions', scope: 'Profile instructions', state: 'changed', summary: swap ? [{ text: '−2', side: 'a' }, { text: ' ' }, { text: '+1', side: 'b' }, { text: ' lines' }] : [{ text: '−1', side: 'a' }, { text: ' ' }, { text: '+2', side: 'b' }, { text: ' lines' }],
        detail: { diff: diff([{ kind: ' ', text: '## Review' }, { kind: '-', text: '- Run the test suite before proposing a commit.' },
          { kind: '+', text: '- Run the full test suite and lint before proposing a commit.' }, { kind: '+', text: '- Explain every skipped check in the final message.' }, { kind: ' ', text: '## Style' }]),
          note: 'Instructions differ. We could not establish which instructions a session loads from setup alone.', sources: [],
          facts: facts([['File read', 'In full', 'In full'], ['Loaded by a session', 'Not known', 'Not known']]) },
        actions: { copy: copy('b', `Copy from ${b} into ${a}…`) } }),
      item({ id: 'proj-agents', name: 'AGENTS.md', category: 'Instructions', scope: 'Project · date-utils', state: 'identical', summary: plain('same file'),
        detail: { values: values('Same project file', 'Same project file', false), note: 'Project files belong to the project and are never copied between profiles.', sources: [], facts: facts([['File read', 'In full', 'In full']]) }, actions: {} }),
    ] },
    { id: 'skills', label: 'Skills', hiddenSame: 6, items: [
      item({ id: 'review-helper', name: 'review-helper', category: 'Skills', scope: 'Profile skill', state: 'changed', summary: [{ text: '2 files changed · ' }, { text: `1 only in ${A}`, side: side('a') }],
        detail: { diff: diff([{ kind: '~', text: 'SKILL.md                  +3 −1' }, { kind: '~', text: 'scripts/check.sh          now executable' },
          { kind: '-', text: `scripts/legacy-lint.sh    only in ${A}` }, { kind: ' ', text: 'references/rubric.md      same' }]),
          note: 'The whole package was compared, including extra files and permissions.', sources: [], facts: facts([['Package read', 'In full', 'In full'], ['Used by a session', 'Not known', 'Not known']]) },
        actions: { copy: copy('b', `Copy from ${b} into ${a}…`), packageHref: `/compare/setups/skills/review-helper?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}` } }),
      item({ id: 'release-notes', name: 'release-notes', category: 'Skills', scope: 'Profile skill', state: 'added', summary: [{ text: 'only in ' }, { text: B, side: side('b') }],
        detail: { values: values('Not present', 'SKILL.md\nscripts/collect.sh\ntemplates/notes.md'), note: `${A} doesn’t have it. That’s certain because its whole skill folder was read.`, sources: [],
          facts: facts([['Present', 'No — skill folder read in full', 'Yes']]) },
        actions: { copy: copy('b', `Copy from ${b} into ${a}…`) } }),
      item({ id: 'pdf', name: 'pdf', category: 'Skills', scope: 'From plugin docs-tools', state: 'unknown', summary: plain('files unreadable'), reason: 'Its files couldn’t be read',
        detail: { values: values('Name visible\nfiles unreadable', 'Name visible\nfiles unreadable', false), note: 'Both list a skill with this name, but its files couldn’t be read, so they may differ.', sources: [], facts: facts([['Package read', 'No', 'No']]) },
        actions: { guidance: ['Plugin skills come with their plugin. Set the plugin up in Codex; Xenoflux never copies or installs it.'] } }),
      item({ id: 'system-skills', name: 'Built-in skills', category: 'Skills', scope: 'Codex client', state: 'unavailable', summary: plain('folder not readable'), reason: 'Access denied',
        detail: { values: values('Couldn’t be read', 'Couldn’t be read', false), note: 'Nothing is claimed about built-in skills, including whether they exist.', sources: [], facts: facts([['Read', 'Access denied', 'Access denied']]) }, actions: {} }),
    ] },
    { id: 'mcp', label: 'MCP and plugins', hiddenSame: 2, items: [
      item({ id: 'github', name: 'mcp_servers.github', category: 'MCP and plugins', scope: 'Profile config.toml', state: 'redacted', summary: plain('command same · token hidden'), reason: 'Secret values are never compared',
        detail: { values: values('command  npx server-github\nGITHUB_TOKEN  ▪ hidden', 'command  npx server-github\nGITHUB_TOKEN  ▪ hidden'),
          note: 'The command matches. Secret values are never shown or compared, so the tokens may differ.', sources: [], facts: facts([['Connected', 'Not known', 'Not known'], ['Signed in', 'Not known', 'Not known']]) },
        actions: { guidance: ['Add it in the other profile’s Codex settings and sign in there.', 'Check first; add only if absent.'] } }),
      item({ id: 'docs-tools', name: 'docs-tools', category: 'MCP and plugins', scope: 'Profile plugin', state: 'removed', summary: [{ text: 'only in ' }, { text: A, side: side('a') }],
        detail: { values: values('Defined\nmanifest 1.4.0', 'Not present', false), note: 'Plugins are set up in Codex. Xenoflux shows the steps but never copies or installs them.', sources: [],
          facts: facts([['Installed', 'Not known', 'No'], ['Enabled', 'Not known', 'Not applicable']]) },
        actions: { guidance: [`Install docs-tools from the Codex plugin list in ${swap ? A : B}.`, 'Check first; install only if absent.'] } }),
    ] },
    { id: 'memory', label: 'Memory settings', hiddenSame: 0, items: [
      item({ id: 'memory', name: 'memory', category: 'Memory settings', scope: 'Profile config.toml', state: 'unknown', summary: plain(`not set in ${B}`), reason: 'Codex’s default isn’t known',
        detail: { values: values('enabled', 'Not set'), note: 'Not set isn’t the same as enabled. Memory contents are never compared or exported.',
          sources: sources([['Profile config.toml', 'enabled', 'Not set'], ['Codex default', 'Not applicable', 'Not known']]),
          facts: [...facts([['Memory contents', 'Not compared', 'Not compared']]), { label: 'Which value wins', value: 'When unset, Codex uses its default, which isn’t known for this version.' }] }, actions: {} }),
    ] },
  ];
}

const PROFILE_NAMES = ['Default', A, B, 'docs-only'];

function sessionRows() {
  return [
    { key: 's1', title: 'Fix the flaky date-parsing test', profile: B, client: 'cli', clientText: 'Codex CLI', project: 'date-utils', recordedAt: 'today 10:41', turns: '5 turns', history: 'complete', historyText: 'History complete', input: 'A' },
    { key: 's2', title: 'Fix the flaky date-parsing test', profile: A, client: 'cli', clientText: 'Codex CLI', project: 'date-utils', recordedAt: 'today 10:14', turns: '4 turns', history: 'complete', historyText: 'History complete', input: 'A' },
    { key: 's3', title: 'Fix flaky date parsing test', profile: B, client: 'desktop', clientText: 'Codex Desktop', project: 'date-utils', recordedAt: 'yesterday 16:02', turns: '7 turns', history: 'partial', historyText: 'Partly recorded', input: 'A+' },
    { key: 's4', title: 'Add CSV export to the report', profile: A, client: 'desktop', clientText: 'Codex Desktop', project: 'report-site', recordedAt: '21 Oct', turns: '3 turns', history: 'complete', historyText: 'History complete', input: 'C' },
    { key: 's5', title: 'Investigate slow startup', profile: 'Default', client: 'cli', clientText: 'Codex CLI', project: 'report-site', recordedAt: '20 Oct', turns: '12 turns', history: 'partial', historyText: 'Partly recorded', input: 'D' },
    { key: 's6', title: 'Fix the flaky date-parsing test', profile: A, client: 'cli', clientText: 'Run here · Codex CLI', project: 'date-utils', recordedAt: '19 Oct', turns: '1 turn', history: 'complete', historyText: 'History complete', input: 'A', startedHere: { reportHref: '/reports/demo-run' } },
  ];
}

function basis(left, right) {
  if (left.input === right.input) return 'recorded';
  if ([left.input, right.input].sort().join('|') === 'A|A+') return 'recorded-later-differ';
  return 'unknown';
}

function report(ref, selection) {
  const sessions = Object.fromEntries(sessionRows().map(row => [row.key, row]));
  const left = sessions[selection.left] ?? sessions.s2, right = sessions[selection.right] ?? sessions.s1;
  const a = left.profile, b = right.profile;
  const association = selection.sameTask ? 'user-declared' : basis(left, right);
  const partialSides = { a: left.history === 'partial', b: right.history === 'partial' };
  const partialKeys = Object.keys(partialSides).filter(side => partialSides[side]);
  const partial = partialKeys.length > 0;
  const partialSession = partialKeys.length === 1 ? (partialKeys[0] === 'a' ? left : right) : null;
  const intended = new Set(selection.variables ?? ['Reasoning effort', 'Profile instructions']);
  const cell = (side, profile, text) => ({ side, profile, text });
  const findings = [
    { id: 'read-first', label: 'different', title: 'Read the failing test before editing',
      cells: [cell('a', a, 'Edited src/date.js, then read the test.'), cell('b', b, 'Read test/date.test.js before its first edit.')],
      caveat: 'Order is within each session; the two clocks aren’t aligned.' },
    { id: 'named-files', label: 'different', title: 'Kept edits to the files you named',
      cells: [cell('a', a, 'Edited only src/ and test/.'), cell('b', b, 'Also edited CHANGELOG.md.')],
      caveat: 'You named the allowed files when building this comparison.' },
    { id: 'skill', label: 'same', title: 'Read the review-helper skill',
      cells: [cell('a', a, 'Read SKILL.md in its first turn.'), cell('b', b, 'Read SKILL.md in its first turn.')],
      caveat: 'Reading a skill doesn’t show it was followed.' },
  ];
  const more = [
    { id: 'final-check', label: 'cannot-compare', title: 'Ran a check before finishing', reason: partial ? `Check results for ${partialKeys.map(side => side === 'a' ? a : b).join(' and ')} weren’t recorded` : `${a}’s result wasn’t recorded`,
      cells: [cell('a', a, partialSides.a ? 'History ends before a check result was recorded.' : 'Ran commands in turn 4, but no result was recorded.'),
        cell('b', b, partialSides.b ? 'History ends before a check result was recorded.' : 'Ran npm test; it passed.')],
      caveat: 'Missing evidence isn’t a failure.' },
    ...(partial ? [{ id: 'later-turns', partialSides: partialKeys, label: 'cannot-compare', title: 'Responded to follow-up prompts', reason: `History after turn 4 for ${partialKeys.map(side => side === 'a' ? a : b).join(' and ')} wasn’t recorded`,
      cells: [cell('a', a, partialSides.a ? 'History after turn 4 wasn’t recorded.' : 'A different follow-up prompt was recorded.'),
        cell('b', b, partialSides.b ? 'History after turn 4 wasn’t recorded.' : 'A different follow-up prompt was recorded.')], caveat: 'Findings use turns 1–4 only; later behavior can’t be compared.' }] : []),
  ];
  const verificationCells = [
    { side: 'a', profile: a, claim: 'The agent said it fixed the test.', checks: [{ status: 'neutral', text: partialSides.a
      ? 'History after turn 4 wasn’t recorded, so whether a check ran is unknown.'
      : 'No check result was recorded.' }] },
    { side: 'b', profile: b, claim: 'The agent said it fixed the test.', checks: [{ status: 'neutral', text: partialSides.b
      ? 'History after turn 4 wasn’t recorded, so whether a check ran is unknown.'
      : 'It ran npm test itself, which passed. That’s the agent’s own check, not an independent one.' }] },
  ];
  const conditionRows = [
    { name: 'Reasoning effort', label: 'different', a: 'medium', b: 'high', intent: intended.has('Reasoning effort') ? 'intended' : 'not-marked' },
    { name: 'Profile instructions (AGENTS.md)', label: 'different', a: 'Instructions differ', b: 'We could not establish which instructions each session loaded.', intent: intended.has('Profile instructions') ? 'intended' : 'not-marked' },
    { name: 'Approval policy', label: 'different', a: 'on-request', b: 'untrusted', intent: intended.has('Approval policy') ? 'intended' : 'not-marked' },
    ...(left.client !== right.client ? [{ name: 'Client', label: 'different', a: left.clientText, b: right.clientText, intent: intended.has('Client') ? 'intended' : 'not-marked' }] : []),
  ];
  const marked = conditionRows.filter(row => row.intent === 'intended').length;
  const assoc = ASSOCIATION[association];
  return {
    ref, title: selection.sameTask || left.title, breadcrumb: 'Choose sessions',
    saved: ref === 'demo-saved' ? { recordedAt: '21 Oct', savedAt: '21 Oct', notInReport: ['Side-by-side code'] } : null,
    a: { side: 'a', profile: a, client: left.clientText, time: left.recordedAt, session: `[SESSION ID ${left.key}]` },
    b: { side: 'b', profile: b, client: right.clientText, time: right.recordedAt, session: `[SESSION ID ${right.key}]` },
    association: { basis: association, title: assoc.title,
      text: association === 'recorded' ? 'Both sessions recorded the same opening task text. Later follow-ups: none on either side.'
        : association === 'recorded-later-differ' ? partialKeys.length > 1
          ? 'Both sessions recorded the same opening task text and different follow-up prompts. Both histories after turn 4 are missing, so later responses can’t be compared.'
          : `Both sessions recorded the same opening task text. ${partialSession?.profile ?? b} (${partialSession?.clientText ?? 'Codex Desktop'}) then got different follow-up prompts.`
          : association === 'user-declared' ? `You said these are the same task (“${selection.sameTask}”). That’s your statement, not proof the inputs matched.`
            : 'The recorded opening task text differs or wasn’t recorded. Findings are still shown; whether they come from the same task is unknown.' },
    counts: countLabels([...findings, ...more]),
    summaryLine: 'Verification: no independent check was recorded · Reviews: 2 reviews attached · One pair, so whether this repeats is unmeasured.',
    conditions: { rows: conditionRows, footer: '4 conditions the same · 1 not recorded',
      all: [{ label: 'Model', value: `${a}: [MODEL] · ${b}: [MODEL]` }, { label: 'Sandbox', value: 'workspace-write on both' }, { label: 'Project', value: 'date-utils on both' },
        { label: 'Network access', value: 'Off on both' }, { label: 'Environment and cache state', value: 'Not recorded' }],
      setupHref: `/compare/setups?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}` },
    limits: [
      `Whether ${a} ran a check at the end — no result was recorded.`,
      'Which instructions each session actually loaded.',
      'Environment and cache state — not recorded in this evidence.',
      ...partialKeys.map(side => `${side === 'a' ? a : b}’s history after turn 4, including file changes and whether checks ran. Findings use turns 1–4 only.`),
      '3 behaviors that the recorded actions can’t show.',
      'Whether these differences repeat — this is one pair, so consistency is unmeasured.',
    ],
    findings, moreFindings: { text: `View all findings · ${more.length} more, ${partial ? 'including turns that weren’t recorded' : 'partly known'}`, items: more },
    evidence: { summary: `${a} has 5 recorded steps on these files and ${b} has 6. One of ${b}’s steps has no counterpart. Steps are grouped by file, not matched one to one.` },
    verification: { none: true, cells: verificationCells, reviews: { text: '2 reviews attached, and they disagree.', href: `/reports/${ref}/reviews` } },
    timeTokens: { rows: [
      { name: 'Recorded time span', a: '[L TIME]', b: '[R TIME]', caveat: 'First to last recorded event; not active working time.' },
      { name: 'Tokens, main session', a: '[L TOKENS]', b: '[R TOKENS]', caveat: 'As counted by Codex for the main session only.' },
      { name: 'Total for the whole workflow', a: 'Not recorded', b: 'Not recorded', caveat: 'Subagent and tool tokens weren’t recorded.' },
    ], footer: 'Not cost, and less time or fewer tokens don’t mean better work.' },
    outcome: { summary: `${a} changed 2 files. ${b} changed 3, one of them outside the files you named.${partialKeys.length ? ` File-change summaries for ${partialKeys.map(side => side === 'a' ? a : b).join(' and ')} may be incomplete because history after turn 4 wasn’t recorded.` : ''} No reviewer has judged the outcomes, and Xenoflux doesn’t pick a better profile.`,
      files: [{ path: 'src/date.js', a: 'Changed', b: 'Changed' }, { path: 'test/date.test.js', a: 'Changed', b: 'Changed' }, { path: 'CHANGELOG.md', a: 'Not changed', b: 'Changed' }],
      code: ref === 'demo-saved' ? null : '--- a/src/date.js\n+++ b/src/date.js\n@@ -12,7 +12,7 @@\n-  return new Date(value);\n+  return new Date(Date.parse(value));' },
    cliCommand: `xfx audit diff --left-profile ${a} --left-id [SESSION ID] --right-profile ${b} --right-id [SESSION ID]`,
    marked,
  };
}

function evidence(ref, rep) {
  const a = rep.a.profile, b = rep.b.profile;
  const S = (text, refText, kind = 'plain', tag) => ({ text, ref: refText, kind, ...(tag ? { tag } : {}) });
  const partial = rep.moreFindings.items.find(finding => finding.id === 'later-turns');
  const partialSides = new Set(partial?.partialSides ?? []);
  const bothPartial = partialSides.size === 2;
  const laterTurns = partial ? {
    id: 'later-turns', label: 'cannot-compare', title: partial.title, counts: { a: partialSides.has('a') ? 1 : 2, b: partialSides.has('b') ? 1 : 2 },
    sentence: { text: bothPartial
      ? 'Both session histories end after turn 4; whether either received or answered follow-up prompts is unknown.'
      : 'One session’s history ends after turn 4; the other has a follow-up prompt recorded. The later behavior can’t be compared.', a, b },
    columns: [
      { side: 'a', profile: a, meta: partialSides.has('a') ? 'history ends after turn 4' : 'follow-up prompt recorded', steps: partialSides.has('a')
        ? [S('Recorded history ends after turn 4', 'Turn 4 · synthetic demo boundary', 'alone', 'Later history unavailable')]
        : [S('Follow-up prompt recorded (text omitted)', 'Turn 5 · synthetic demo event'), S('Response to follow-up not shown', 'Turn 5 · synthetic demo limit', 'alone')] },
      { side: 'b', profile: b, meta: partialSides.has('b') ? 'history ends after turn 4' : 'follow-up prompt recorded', steps: partialSides.has('b')
        ? [S('Recorded history ends after turn 4', 'Turn 4 · synthetic demo boundary', 'alone', 'Later history unavailable')]
        : [S('Follow-up prompt recorded (text omitted)', 'Turn 5 · synthetic demo event'), S('Response to follow-up not shown', 'Turn 5 · synthetic demo limit', 'alone')] },
    ],
  } : null;
  return { ref, title: rep.title, explanation: 'This is paired synthetic demo evidence. Steps are shown in the order recorded; steps on one line aren’t matched, and the two sessions’ clocks aren’t aligned.',
    refsNote: 'The turn and line markers are illustrative demo references, not links to real session history. Commands, file contents and conversation text aren’t shown; nothing here verifies a real session.',
    findings: [
      { id: 'read-first', label: 'different', title: 'Read the failing test before editing', counts: { a: 5, b: 6 },
        sentence: { text: '{b} read the test before its first change; {a} changed code first.', a, b },
        columns: [
          { side: 'a', profile: a, meta: '5 steps on these files', steps: [S('Read the review-helper skill', 'Turn 1 · history line 41'), S('Read src/date.js', 'Turn 1 · history line 77'),
            S('Changed src/date.js', 'Turn 2 · history line 112', 'cited', 'First change'), S('Read test/date.test.js', 'Turn 2 · history line 131', 'cited', 'First time it read the test'), S('Changed test/date.test.js', 'Turn 3 · history line 160')] },
          { side: 'b', profile: b, meta: '6 steps on these files', steps: [S('Read the review-helper skill', 'Turn 1 · history line 39'), S('Read test/date.test.js', 'Turn 1 · history line 58', 'cited', 'Read the test before any change'),
            S('Ran the date tests; they failed', 'Turn 1 · history line 70'), S('Read src/date.js', 'Turn 2 · history line 96'), S('Changed src/date.js', 'Turn 2 · history line 118', 'cited', 'First change'), S('Changed test/date.test.js', 'Turn 3 · history line 144')] },
        ] },
      { id: 'skill', label: 'same', title: 'Read the review-helper skill', counts: { a: 1, b: 1 },
        sentence: { text: 'Both synthetic histories show the skill being read in turn 1. Reading it doesn’t show that either session followed it.', a, b },
        columns: [
          { side: 'a', profile: a, meta: '1 recorded skill read', steps: [S('Read the review-helper skill', 'Turn 1 · synthetic demo event')] },
          { side: 'b', profile: b, meta: '1 recorded skill read', steps: [S('Read the review-helper skill', 'Turn 1 · synthetic demo event')] },
        ] },
      { id: 'named-files', label: 'different', title: 'Kept edits to the files you named', counts: { a: 2, b: 3 },
        sentence: { text: '{b} also changed CHANGELOG.md; {a} changed only the files you named.', a, b },
        columns: [
          { side: 'a', profile: a, meta: '2 files changed', steps: [S('Changed src/date.js', 'Turn 2 · history line 112', 'cited'), S('Changed test/date.test.js', 'Turn 3 · history line 160', 'cited')] },
          { side: 'b', profile: b, meta: '3 files changed', steps: [S('Changed src/date.js', 'Turn 2 · history line 118', 'cited'), S('Changed test/date.test.js', 'Turn 3 · history line 144', 'cited'),
            S('Changed CHANGELOG.md', 'Turn 4 · history line 171', 'alone', 'Not one of the files you named')] },
        ] },
      { id: 'final-check', label: 'cannot-compare', title: 'Ran a check before finishing', counts: { a: 1, b: 1 },
        sentence: { text: 'At least one side has no recorded check result. Missing evidence isn’t a failure.', a, b },
        columns: [
          { side: 'a', profile: a, meta: partialSides.has('a') ? 'later history not recorded' : 'result not recorded', steps: [S(partialSides.has('a') ? 'History ends before a check result was recorded' : 'Ran commands in turn 4, but no result was recorded', partialSides.has('a') ? 'Turn 4 · synthetic demo boundary' : 'Turn 4 · synthetic demo event', 'alone')] },
          { side: 'b', profile: b, meta: partialSides.has('b') ? 'later history not recorded' : '1 check', steps: [S(partialSides.has('b') ? 'History ends before a check result was recorded' : 'Ran npm test; it passed', partialSides.has('b') ? 'Turn 4 · synthetic demo boundary' : 'Turn 5 · synthetic demo event', partialSides.has('b') ? 'alone' : 'cited')] },
        ] },
      ...(laterTurns ? [laterTurns] : []),
    ] };
}

export function createDemoProvider({ version = 'demo' } = {}) {
  const inspections = new Map();
  const inspectionRuns = new Map();
  const inspectedPairs = new Map();
  const selections = new Map();
  const reports = new Map();
  const copies = new Map();
  const runs = new Map();
  const runPreviews = new Map();
  const recoveryPreviews = new Map();
  const reviewPreviews = new Map();
  const reviewTasks = new Map();
  const saved = [
    { id: 'saved-csv', title: 'Add CSV export to the report', savedAt: 'saved 21 Oct', folder: '[REPORTS FOLDER]/Add CSV export to the report — 21 Oct/' },
  ];
  const clientState = { [A]: { cli: 'running', desktop: 'not-running' }, [B]: { cli: 'unavailable', desktop: 'running' }, 'docs-only': { cli: 'not-running', desktop: 'not-running' }, Default: { cli: 'not-running', desktop: 'not-running' } };
  const reportFor = ref => {
    if (inspectedPairs.has(ref)) {
      const pair = inspectedPairs.get(ref);
      const view = presentComparison(pair.value, { title: pair.title });
      return { ...view, ref, breadcrumb: 'Session inspections', retained: true, saved: null, cliCommand: '',
        sessionHarness: { a: presentSessionHarness(pair.value.left), b: presentSessionHarness(pair.value.right) },
        verification: { ...view.verification, reviews: { ...view.verification.reviews, href: null } } };
    }
    if (ref === 'demo-run') return report(ref, { left: 's6', right: 's1' });
    if (ref === 'demo-saved') return { ...report(ref, { left: 's4', right: 's1' }), title: 'Add CSV export to the report' };
    const frozen = [...reviewTasks.values()].find(task => task.reportRef === ref);
    if (frozen) return { ...reportFor(frozen.sourceRef), ref, title: frozen.title, frozen: true };
    const selection = reports.get(ref);
    if (!selection) throw new UiError(404, 'This report isn’t open any more. Choose the sessions again or open the saved report.', 'report-missing');
    return report(ref, selection);
  };

  function profileCard(name) {
    const state = clientState[name];
    const clientText = (client, value) => value === 'running' ? (client === 'cli' ? 'running in Terminal' : 'open')
      : value === 'unavailable' ? 'not available while its Desktop is open' : 'not running';
    const actions = [];
    const conflict = { title: `${name} is open in Codex CLI`, body: `A profile can't run in Codex CLI and Codex Desktop at the same time. Finish and close ${name}'s Terminal session, then try again. Other profiles aren't affected.` };
    if (name === 'docs-only') actions.push({ id: 'open-terminal', label: 'Open in Terminal to sign in…' });
    else if (state.cli === 'running') actions.push({ id: 'show-terminal', label: 'Show Terminal' }, { id: 'open-desktop', label: 'Open Codex Desktop…', conflict });
    else if (state.desktop === 'running') actions.push({ id: 'focus-desktop', label: 'Show Codex Desktop' });
    else actions.push({ id: 'open-terminal', label: 'Open in Terminal (Codex CLI)…' }, { id: 'open-desktop', label: 'Open Codex Desktop' });
    const desktopOpen = state.desktop === 'running';
    const meta = {
      Default: ['Signed in', 'no project', 'Your normal Codex setup · medium reasoning · 7 skills found. Other profiles can copy from it; nothing is copied into it.'],
      [A]: ['Signed in', 'bound to date-utils', 'Medium reasoning · 9 skills found · 1 plugin defined'],
      [B]: ['Signed in', 'bound to date-utils', 'High reasoning · 10 skills found · no plugins defined'],
      'docs-only': ['Sign-in unknown', 'no project', 'Low reasoning · 2 skills found. Sign in from Codex itself; Xenoflux never signs in for you or copies credentials.'],
    }[name];
    return {
      name, isDefault: name === 'Default', state: 'ready', reason: null, signIn: meta[0], binding: meta[1], summary: meta[2],
      cli: { state: state.cli === 'unavailable' ? 'unavailable' : state.cli, text: clientText('cli', state.cli) },
      desktop: { state: state.desktop, text: clientText('desktop', state.desktop) },
      clientActions: actions,
      moreMenu: name === 'Default' ? null : [
        { id: 'copy', label: 'Copy settings from another profile…', detail: `Choose items, see exactly what changes in ${name}, undo later` },
        { id: 'binding', label: 'Change project binding…' },
        { id: 'rename', label: 'Rename…' },
        { id: 'remove', label: 'Remove from Xenoflux…', detail: 'Keeps the profile’s files on disk.', ...(desktopOpen ? { disabledReason: 'Not available while its Desktop is open.' } : {}) },
      ],
    };
  }

  return {
    async info() {
      const active = [...runs.values()].find(run => run.state === 'running');
      return { mode: 'demo', version, features: { runs: true, copy: true, create: true, clientControls: true, profileEdits: true },
        activeRun: active ? { id: active.id, task: active.task, profiles: [active.a, active.b], href: `/runs/${active.id}` } : null };
    },
    async discovery() {
      return { checkedAt: new Date().toISOString(), scope: ['Synthetic demo locations only'],
        registry: { kind: 'readable', reason: null }, attention: [], limits: [], simulated: true,
        clients: [['codex', 'Codex'], ['claude-code', 'Claude Code'], ['copilot', 'GitHub Copilot']].map(([client, name]) => ({
          client, name, cli: { kind: 'found', label: 'Found (simulated)', location: `[DEMO]/bin/${client}`, version: null, identity: `demo-${client}` },
          desktop: { kind: 'unavailable', label: 'Could not confirm (simulated)', reason: 'No real app is inspected in demo mode.' },
          desktopNote: 'Open a managed profile from Profiles. Desktop startup and profile storage are supported; sign-in and task execution remain unverified.',
          setups: [{ key: `demo-${client}`, name: 'Default', origin: 'Synthetic standard folder', kind: 'found', label: 'Folder found (simulated)',
            location: `[DEMO]/${client}`, reason: 'Simulated folder presence. Sign-in and eligibility are not checked.', inspectHref: `/profiles/Default/setup?client=${client}` }],
        })) };
    },
    async overview() {
      return { profileCount: 4, readyToRun: 3,
        sessions: { status: 'partial', text: '6 sessions in 3 profiles · 1 profile couldn’t be read' },
        runs: { available: true, text: '3 profiles ready to run' },
        setups: { text: '4 profiles · read-only, nothing is copied, activated or signed in' },
        recent: [
          { kind: 'task', title: 'Fix the flaky date-parsing test', meta: `${A} vs ${B} · today`, href: '/reports/demo-run' },
          { kind: 'setup', title: `${A} vs ${B}`, meta: 'setup as of 23 Oct', href: `/compare/setups?a=${A}&b=${B}` },
          { kind: 'saved', title: 'Add CSV export to the report', meta: 'saved report · recorded 21 Oct', href: '/reports/demo-saved' },
        ] };
    },
    async profiles() {
      return { profiles: PROFILE_NAMES.map(profileCard), notes: ['Looking at a profile never changes it or opens Codex. Different profiles can be open at the same time.'], simulated: true };
    },
    async clientAction({ name, action }) {
      if (!clientState[name]) throw new UiError(404, `Profile not found: ${name}`, 'not-found');
      const state = clientState[name];
      if (action === 'check') return { status: 'neutral', message: `Checked ${name} again (simulated).`, profile: profileCard(name) };
      if (action === 'open-desktop' && state.cli === 'running') throw new UiError(409, `${name} is open in Codex CLI. Close its Terminal session first.`, 'client-conflict');
      if (action === 'open-desktop') { state.desktop = 'running'; state.cli = 'unavailable'; }
      if (action === 'open-terminal') state.cli = 'running';
      return { status: 'success', message: `Simulated: ${action.replace('-', ' ')} for ${name}. Nothing was opened.`, profile: profileCard(name) };
    },
    async setupChoices() {
      return { choices: [...PROFILE_NAMES.map(name => ({ name, client: 'codex' })),
        ...['claude-code', 'copilot'].map(client => ({ name: 'Default', client }))].map(({ name, client }) => ({
        key: JSON.stringify([client, name]), name, client, label: `${name} · ${SETUP_CLIENTS[client]}`, available: true, reason: null,
      })), warnings: ['Synthetic demo setups.'] };
    },
    async profileSetup({ name, client = 'codex', repo }) {
      if (!SETUP_CLIENTS[client] || (client === 'codex' ? !PROFILE_NAMES.includes(name) : name !== 'Default')) throw new UiError(404, 'Synthetic setup not found.', 'not-found');
      return { profile: { name, client, meta: SETUP_CLIENTS[client] }, project: repo ?? null,
        readAt: 'Simulated current setup', inventory: demoSetup(name, client, repo) };
    },
    async setupComparison({ a = A, b = B, aClient = 'codex', bClient = 'codex', repo }) {
      if (aClient !== bClient) {
        const sides = await Promise.all([this.profileSetup({ name: a, client: aClient, repo }), this.profileSetup({ name: b, client: bClient, repo })]);
        return { a: sides[0].profile, b: sides[1].profile, project: repo ?? null, readAt: 'Simulated current setup',
          counts: { different: 0, same: 0, cannotCompare: 0 }, limits: null, groups: [],
          separate: { reason: 'Mixed-client setups are shown separately; categories and settings are not equivalent.', a: sides[0].inventory, b: sides[1].inventory } };
      }
      if (a === b) return { a: { name: a }, b: { name: b }, project: null, readAt: '', counts: { different: 0, same: 0, cannotCompare: 0 }, limits: null, groups: [], blocked: 'Choose two different profiles.' };
      for (const name of [a, b]) if (!PROFILE_NAMES.includes(name)) throw new UiError(404, `Profile not found: ${name}`, 'not-found');
      const groups = setupItems(a, b).map(group => {
        const counts = countLabels(group.items);
        counts.same += group.hiddenSame;
        return { id: group.id, label: group.label, items: group.items, counts, meta: groupMeta(counts), hiddenSame: group.hiddenSame };
      });
      const counts = groups.reduce((sum, group) => ({ different: sum.different + group.counts.different, same: sum.same + group.counts.same, cannotCompare: sum.cannotCompare + group.counts.cannotCompare }), { different: 0, same: 0, cannotCompare: 0 });
      return { a: { name: a, meta: 'Codex CLI' }, b: { name: b, meta: 'Codex CLI' }, project: 'date-utils', readAt: 'Today’s setup, read 26 Oct at 14:02',
        counts, groups,
        limits: { text: 'Codex built-ins couldn’t be read in either profile, and plugins were only partly read. Nothing is claimed about what wasn’t read.',
          coverage: [{ area: 'Profile config and instructions', a: 'Read in full', b: 'Read in full' }, { area: 'Profile skills', a: 'Read in full', b: 'Read in full' },
            { area: 'Plugins', a: 'Partly read', b: 'Partly read' }, { area: 'Codex built-ins', a: 'Access denied', b: 'Access denied' }, { area: 'Project · date-utils', a: 'Read in full', b: 'Read in full' }] } };
    },
    async skillDetail({ skill, a = A, b = B }) {
      if (skill !== 'review-helper') throw new UiError(404, 'No package detail for this skill in the demo.', 'not-found');
      const flip = a !== A;
      const only = flip ? 'b' : 'a';
      const lines = [{ kind: ' ', text: '## When to use' }, { kind: '-', text: 'Use before opening a pull request.' }, { kind: '+', text: 'Use before opening a pull request or tagging a release.' },
        { kind: '+', text: 'Run scripts/check.sh first; stop if it exits non-zero.' }, { kind: '+', text: 'Report skipped checks explicitly.' }, { kind: ' ', text: '## Steps' }]
        .map(line => flip ? { ...line, kind: line.kind === '-' ? '+' : line.kind === '+' ? '-' : line.kind } : line);
      return { name: 'review-helper', label: 'different', a: { name: a }, b: { name: b },
        coverage: 'A personal skill in both profiles. All 4 files were read in full on both sides, including their permissions.',
        toolsNote: 'Tools it calls, like npx eslint, aren’t checked, and copying the skill wouldn’t install them.',
        files: [
          { path: 'SKILL.md', label: 'different', exactText: 'Changed', summary: flip ? [{ text: '−3', side: 'a' }, { text: ' ' }, { text: '+1', side: 'b' }, { text: ' lines' }] : [{ text: '−1', side: 'a' }, { text: ' ' }, { text: '+3', side: 'b' }, { text: ' lines' }], diff: lines },
          { path: 'scripts/check.sh', label: 'different', exactText: 'Changed', summary: [{ text: 'runnable only in ' }, { text: B, side: flip ? 'a' : 'b' }], statement: `Same content. It can be run as a program only in ${B}.` },
          { path: 'scripts/legacy-lint.sh', label: 'different', exactText: `Only in ${A}`, summary: [{ text: 'only in ' }, { text: A, side: only }], only: { side: only, lines: ['#!/bin/sh', 'set -eu', 'npx eslint --max-warnings 0 .'] } },
          { path: 'references/rubric.md', label: 'same', exactText: 'Same within what was read', summary: [{ text: 'Same in both' }] },
        ],
        copy: { label: `Copy ${B}’s version into ${A}…`, aToB: `${B}’s version into ${A}: updates SKILL.md, makes check.sh runnable and removes legacy-lint.sh from ${A}.`, bToA: `${A}’s version into ${B}: reverts SKILL.md, makes check.sh not runnable and adds legacy-lint.sh.`,
          href: `/profiles/${encodeURIComponent(A)}/copy?from=${encodeURIComponent(B)}&item=review-helper` } };
    },
    async sessions({ query = '', profile = '', client = '' }) {
      const q = query.trim().toLowerCase();
      const rows = sessionRows().filter(row => (!profile || row.profile === profile) && (!client || row.client === client)
        && (!q || `${row.title} ${row.project}`.toLowerCase().includes(q)));
      return { sessions: rows.map(({ input, ...row }) => row), profiles: PROFILE_NAMES,
        partial: { text: 'docs-only’s history couldn’t be read (access denied). Sessions from the other profiles are listed.', help: 'macOS asks before an app reads some folders. Allow access for the terminal that runs xfx ui in System Settings › Privacy & Security › Files and Folders, then reload.' },
        truncated: false };
    },
    async codexSessions({ profile }) { return this.demoSessionList('codex', profile); },
    async claudeSessions({ profile }) { return this.demoSessionList('claude-code', profile); },
    async copilotSessions({ profile }) { return this.demoSessionList('copilot', profile); },
    async demoSessionList(client, profile) {
      const token = randomUUID(); selections.set(token, { client, profile });
      return { client, profileId: profile, rootMode: profile === 'Default' ? 'implicit' : 'explicit', executionLocation: 'local',
        sessions: [{ token, title: 'Synthetic session for inspection', modifiedAt: '2026-11-13T10:00:00Z' }] };
    },
    async inspectSession(input = {}) {
      const selected = input.token ? selections.get(input.token) : null;
      const row = sessionRows().find(row => row.key === input.key);
      if (!selected && !row && !input.report) throw new UiError(400, 'Choose a synthetic session.', 'invalid-session-selection');
      const ref = `demo-inspect-${randomUUID()}`, sessionId = '00000000-0000-4000-8000-000000000001';
      const client = selected?.client ?? 'codex', profile = selected?.profile ?? row?.profile ?? A;
      const run = { kind: 'audit-run', schemaVersion: 1, profile: { profileName: profile }, clientIdentity: { client },
        source: { kind: 'demo-history-import', nativeSessionId: sessionId }, coverage: { timeline: 'partial' },
        sessionReplay: { schemaVersion: 1, kind: 'session-replay', sessions: [{ id: sessionId, parentId: null, status: 'partial',
          source: { fingerprint: 'a'.repeat(64) }, limits: [{ message: 'Synthetic evidence only.' }],
          events: [{ id: 'demo-opening', sessionId, turnId: null, kind: 'message', role: 'user', label: 'User message',
            timestamp: null, sourceLine: 1, body: 'Inspect the recorded session and its harness.', bodyStatus: 'included' }] }] } };
      inspectionRuns.set(ref, run);
      inspections.set(ref, { ...presentSession(run, { title: row?.title ?? 'Synthetic session inspection' }), ref, savedAt: null,
        exportHref: `/reports/${ref}/export` });
      return { ref, href: `/sessions/${ref}` };
    },
    async sessionInspection({ ref }) {
      if (!inspections.has(ref)) throw new UiError(404, 'Choose the synthetic session again.', 'not-found');
      return structuredClone(inspections.get(ref));
    },
    async compareInspections({ left, right } = {}) {
      const a = inspectionRuns.get(left), b = inspectionRuns.get(right);
      if (!a || !b) throw new UiError(410, 'Choose both synthetic inspections again.', 'session-inspection-missing');
      if (left === right || a.clientIdentity.client === b.clientIdentity.client && a.profile.profileName === b.profile.profileName)
        throw new UiError(400, 'Choose two different synthetic sessions.', 'duplicate-session-selection');
      const ref = `demo-pair-${randomUUID()}`;
      inspectedPairs.set(ref, { value: compareAuditRuns(a, b), title: inspections.get(left).title });
      return { ref };
    },
    async association({ left, right }) {
      const rows = Object.fromEntries(sessionRows().map(row => [row.key, row]));
      const l = rows[left], r = rows[right];
      if (!l || !r) throw new UiError(400, 'Choose two sessions.', 'invalid-selection');
      const kind = basis(l, r);
      const suggested = ['Reasoning effort', 'Profile instructions', ...(l.client !== r.client ? ['Client'] : [])];
      const strip = ({ input, ...row }) => row;
      return { basis: kind, title: ASSOCIATION[kind].title, text: ASSOCIATION[kind].text, suggestedVariables: suggested, sides: { a: strip(l), b: strip(r) } };
    },
    async compareSessions({ left, right, sameTask, variables }) {
      if (!left || !right || left === right) throw new UiError(400, 'Choose two different sessions.', 'invalid-selection');
      const ref = `demo-${randomUUID().slice(0, 8)}`;
      reports.set(ref, { left, right, sameTask: typeof sameTask === 'string' && sameTask.trim() ? sameTask.trim() : undefined, variables: Array.isArray(variables) ? variables : [] });
      return { ref };
    },
    async report({ ref }) { const value = reportFor(ref); delete value.marked; return value; },
    async evidence({ ref }) { return evidence(ref, reportFor(ref)); },
    async reviews({ ref }) {
      const rep = reportFor(ref);
      return { ref, title: rep.title,
        canPrepare: true, hasReviews: true,
        reviewOptions: { profiles: PROFILE_NAMES.map(name => ({ name, ready: true,
          readiness: 'Simulated demo profile; no local profile is read.' })),
        workspaces: [{ path: '/demo/date-utils', available: true }],
        prompt: 'Review the supplied comparison report. Cite evidence and state limitations.',
        includeRecordedContent: false, defaults: { timeoutMs: null } },
        reviewTasks: [...reviewTasks.values()].filter(task => task.sourceRef === ref || task.reportRef === ref).map(task => ({ id: task.id,
          status: task.status, createdAt: task.createdAt, profile: task.profile, summary: task.response?.text ?? 'Simulated review task.' })),
        topics: [
          { title: 'How good the results are', meta: '2 reviews · 1 earlier version', disagreement: 'The reviewers disagree. Both views are shown side by side, not combined into a score or a winner.', notReviewed: false, reviews: [
            { kind: 'human', reviewer: '[REVIEWER NAME]', verdict: 'mixed', prefers: 'neither', quote: `${rep.b.profile}'s fix addresses the cause more thoroughly, but it also changed CHANGELOG.md, which wasn't asked for.`,
              basedOn: [{ text: `${rep.b.profile} changed CHANGELOG.md`, href: null }, { text: `${rep.b.profile}'s repeat test`, href: null }, { text: 'changes to src/date.js', href: null }],
              date: 'Written [DATE] · updated version', earlier: { verdict: 'Inconclusive', quote: 'Need to see whether the repeat test passed before judging.', date: '[DATE] · kept for the record' } },
            { kind: 'ai', reviewer: '[MODEL]', verdict: 'positive', prefers: rep.b.profile, quote: `${rep.b.profile} reproduced the failure before changing anything, and its 20-run repeat test passed.`,
              basedOn: [{ text: `${rep.b.profile} read the test first`, href: null }, { text: `${rep.b.profile}'s repeat test`, href: null }],
              date: 'Imported from a review file · [DATE]', earlier: null },
          ] },
          { title: 'Reading the test before editing', meta: 'No reviews', disagreement: null, notReviewed: true, reviews: [] },
        ],
        consistency: 'Can’t be reviewed with one pair: consistency is unmeasured.',
        checksAfter: [{ status: 'success', text: 'Date test, 50 times: passed', by: `on ${rep.b.profile}'s result · run by [CHECKER NAME] (person) on the same version that was recorded` }] };
    },
    async previewReviewTask({ ref, profile = A, cwd = '/demo/date-utils', prompt = 'Review the supplied comparison report. Cite evidence and state limitations.', includeRecordedContent = false, timeoutMs = null } = {}) {
      const rep = reportFor(ref);
      if (!PROFILE_NAMES.includes(profile)) throw new UiError(400, 'Choose a demo profile.', 'invalid-review-profile');
      const previewToken = randomUUID();
      const taskDirectory = `/demo/review-tasks/${previewToken}`;
      const effectivePrompt = `${prompt}\n\nSimulated input paths:\n- ${taskDirectory}/report.md\n- ${taskDirectory}/report.md.audit.json\n- ${taskDirectory}/prompt.md`;
      const preview = { ready: true, previewToken, blocked: null, title: rep.title, profile, cwd, prompt, effectivePrompt,
        includeRecordedContent: Boolean(includeRecordedContent), executable: '[simulated Codex executable]', model: 'Not run',
        reasoningEffort: 'Demo value only', timeoutMs, inputs: [
          { name: 'report.md', path: `${taskDirectory}/report.md`, bytes: 1536, sha256: 'demo-only-report', source: `${taskDirectory}/report.md` },
          { name: 'report.md.audit.json', path: `${taskDirectory}/report.md.audit.json`, bytes: 2048, sha256: 'demo-only-evidence', source: `${taskDirectory}/report.md.audit.json` },
          { name: 'prompt.md', path: `${taskDirectory}/prompt.md`, bytes: effectivePrompt.length, sha256: 'demo-only-prompt', source: `${taskDirectory}/prompt.md` }],
        contentChoice: includeRecordedContent ? 'Recorded content selected (simulated)' : 'Recorded content omitted',
        summary: 'This preview is simulated. Starting it will show a sample response; no model will run.',
        limits: ['Simulation only; no provider call or native request.', 'No profile, workspace, or report files are read or changed.'],
        willDo: ['Show a staged simulated review response'], never: ['Run a model', 'Change files or profile settings'], simulated: true };
      reviewPreviews.set(previewToken, { ref, preview });
      return preview;
    },
    async startReviewTask({ ref, previewToken } = {}) {
      const saved = reviewPreviews.get(previewToken);
      if (!saved || saved.ref !== ref) throw new UiError(409, 'This demo preview is unavailable. Prepare it again.', 'review-preview-stale');
      if (saved.taskId) return { id: saved.taskId };
      const id = previewToken;
      const task = { id, sourceRef: ref, reportRef: `r.${id}`, title: saved.preview.title, profile: saved.preview.profile,
        status: 'completed', phase: 'completed', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        threadId: null, turnId: null, cwd: saved.preview.cwd, response: { status: 'complete', text: 'Simulated review: the recorded comparison suggests the strict-review profile produced a more thorough fix, while the extra CHANGELOG.md edit is outside the stated request. This is sample text for the demo, not a model response. The retained evidence does not establish that the same result would repeat.', threadId: null, turnId: null },
        pendingRequests: [], nativeSettings: null, shutdown: null, error: null, cancellation: null, limits: saved.preview.limits, simulated: true };
      saved.taskId = id; reviewTasks.set(id, task);
      return { id };
    },
    async reviewTask({ id } = {}) {
      const task = reviewTasks.get(id);
      if (!task) throw new UiError(404, 'This simulated task is not available.', 'not-found');
      return structuredClone(task);
    },
    async cancelReviewTask({ id } = {}) {
      const task = reviewTasks.get(id);
      if (!task) throw new UiError(404, 'This simulated task is not available.', 'not-found');
      return structuredClone(task);
    },
    async respondReviewTask({ id } = {}) {
      if (!reviewTasks.has(id)) throw new UiError(404, 'This simulated task is not available.', 'not-found');
      throw new UiError(409, 'The demo simulation has no native approval or input requests.', 'stale-review-request');
    },
    async exportPlan({ ref }) {
      if (inspections.has(ref)) {
        const view = inspections.get(ref);
        return { ref, href: `/sessions/${ref}`, title: view.title, folder: '[REPORTS FOLDER]/Synthetic session/', name: 'session', files: ['session.md', 'session.md.audit.json'],
          included: ['Retained session evidence and limits'], neverIncluded: ['Private internal reasoning', 'Credentials'], contentFiles: [], replayAvailable: true,
          privacy: 'Synthetic content only. Real session content can contain private information.' };
      }
      const rep = reportFor(ref);
      return { ref, title: rep.title, folder: `[REPORTS FOLDER]/${rep.title} — 26 Oct/`, name: 'date-parsing-fix', files: ['date-parsing-fix.md', 'date-parsing-fix.md.audit.json'],
        included: ['Recorded conditions', 'Findings with their limits', 'Evidence references', 'Checks', 'Reviews attached earlier, with their reviewers', 'Time and token measurements with their scope', 'What couldn’t be seen'],
        neverIncluded: ['Raw prompts and transcripts', 'Tool output', 'Credentials and secret values', 'Memory contents'],
        contentFiles: ['AGENTS.md', 'review-helper/SKILL.md', 'release-notes/SKILL.md'],
        privacy: 'File paths, profile names and usage figures can still be personal. Read the report before sharing it beyond this Mac.' };
    },
    async exportReport({ ref, includeContent }) {
      const plan = await this.exportPlan({ ref });
      saved.unshift({ id: `saved-${randomUUID().slice(0, 8)}`, title: plan.title, savedAt: 'saved today', folder: plan.folder });
      return { folder: plan.folder, files: plan.files, contentIncluded: includeContent ? `included for ${plan.contentFiles.length} files` : 'not included', simulated: true };
    },
    async savedReports() { return { recent: saved.slice(0, 5) }; },
    async openReport({ fileName = '', text }) {
      if (/\.md$/i.test(fileName)) throw new UiError(422, `Found ${fileName}, but not ${fileName}.audit.json`, 'json-missing', { markdown: fileName });
      if (typeof text !== 'string' || !text.trim().startsWith('{')) throw new UiError(422, 'This file isn’t a saved Xenoflux report. Choose the file ending in .audit.json.', 'unreadable');
      return this.openRecentReport({ id: 'saved-csv' });
    },
    async openRecentReport({ id }) {
      const entry = saved.find(item => item.id === id) ?? saved[0];
      return { id: entry.id, title: entry.title, recordedAt: '21 Oct', savedAt: '21 Oct', ref: 'demo-saved',
        kept: [{ label: 'Conditions, findings and limits', value: 'Kept' }, { label: 'Reviews attached earlier', value: 'Kept, with reviewers and earlier revisions' },
          { label: 'Evidence references', value: 'Kept; the original history can’t be opened' }, { label: 'Side-by-side code', value: 'Not in this report' }],
        cliCommand: 'xfx audit show "[REPORTS FOLDER]/…/report.md.audit.json"' };
    },
    async runOptions() {
      return { profiles: [{ name: A, readiness: 'Signed in · ready', ready: true }, { name: B, readiness: 'Signed in · ready', ready: true }, { name: 'Default', readiness: 'Signed in · ready', ready: true },
        { name: 'docs-only', readiness: 'Sign-in unknown · it can’t run until you sign in from Codex', ready: false }],
      repositories: [{ path: '[PROJECT FOLDER]', commit: 'main' }],
      defaults: { timeMinutes: 15, access: 'Codex can edit only its copy, no network', outputCap: '8 MiB', outputMiB: 8, program: '' }, simulated: true };
    },
    async runPreview(request) {
      const { a, b, task = '', checks = [] } = request;
      if (!a || !b || a === b) throw new UiError(400, 'Choose two different profiles.', 'same-profile');
      if (!task.trim()) throw new UiError(400, 'Describe the task both profiles should do.', 'task-missing');
      const blocked = [a, b].includes('docs-only') ? { title: 'docs-only can’t run yet', reason: 'Its sign-in couldn’t be confirmed. Xenoflux won’t sign in for you or swap in another profile. Start stays unavailable until this is resolved.' } : null;
      const valid = checks.filter(check => check.command?.trim());
      const advanced = request.advanced;
      const timeMinutes = advanced?.timeMinutes ?? 15;
      const outputMiB = advanced?.outputMiB ?? 8;
      const setup = advanced?.setup ?? [];
      const previewToken = blocked ? null : randomUUID();
      const result = { ready: !blocked, blocked, previewToken, simulated: true,
        summary: `2 model runs, one after the other · up to ${timeMinutes * 2 + 2} min`, limit: `Each run stops after ${timeMinutes} minutes; the whole task after ${timeMinutes * 2 + 2}.`,
        task, files: request.files ?? '',
        runs: [{ side: 'a', profile: a, text: 'left side of the report · its usual Codex CLI · its own settings · ready' },
          { side: 'b', profile: b, text: 'right side of the report · its usual Codex CLI · its own settings · ready',
            ...(b === B ? { note: 'Codex Desktop is open in this profile. It keeps running; the run uses separate processes.' } : {}) }],
        where: [`Each profile gets its own copy of ${request.repository || '[repository]'} at ${request.commit || '[COMMIT]'}.`, 'Uncommitted edits and untracked or ignored files aren’t included. You have 3 uncommitted files.',
          'Preparing the copies leaves your folder and its Git index untouched.', 'That doesn’t limit what commands run during the task, or your checks, can affect outside the copy.'],
        checks: valid.map(check => `${check.name || 'Check'}: ${check.command}`),
        limits: [`Each run stops after ${timeMinutes} minutes; the whole task after ${timeMinutes * 2 + 2}.`, `Left permissions: ${request.execution?.a?.permissionMode ?? 'workspace-write'}; right permissions: ${request.execution?.b?.permissionMode ?? 'workspace-write'}. Output cap ${outputMiB} MiB per program.`, `Codex program: ${advanced?.program || 'profile default'}; reasoning effort: ${advanced?.reasoningEffort || 'profile default'}.`, 'A run that stops early is reported as stopped. Runs aren’t retried.', ...(setup.length ? [`Runs ${setup.length} setup command${setup.length === 1 ? '' : 's'} before the task.`] : [])],
        willDo: ['Run 2 model tasks, one after the other, using each profile’s sign-in', ...(setup.length ? [`Run setup commands: ${setup.map(item => item.name || '(unnamed)').join(', ')}`] : []), 'Save the evidence and open the comparison report'],
        never: ['Changes, copies or activates profile settings', 'Signs in, or swaps in another profile if one fails', 'Closes your Codex windows'],
        cliCommand: 'xfx audit run --spec experiment.json' };
      if (result.ready) runPreviews.set(previewToken, { request: structuredClone(request), preview: result, created: Date.now(), runId: null });
      return result;
    },
    async startRun({ previewToken }) {
      const saved = runPreviews.get(previewToken);
      if (!saved) throw new UiError(409, 'This preview has expired or was not found. Refresh the preview, then review it again.', 'preview-stale');
      if (saved.runId) return { id: saved.runId };
      const { request, preview } = saved;
      if (!preview.ready) throw new UiError(409, preview.blocked.reason, 'not-ready');
      if ([...runs.values()].some(run => run.state === 'running')) throw new UiError(409, 'A task run is already in progress. Wait for it to finish or cancel it.', 'run-active');
      const id = randomUUID();
      runs.set(id, { id, task: request.task.split('\n')[0].slice(0, 80), a: request.a, b: request.b, started: Date.now(), state: 'running', checks: preview.checks.length });
      saved.runId = id;
      return { id };
    },
    async run({ id }) {
      const run = runs.get(id) ?? (id === 'demo-interrupted' ? { id, task: 'Fix the flaky date-parsing test', a: A, b: B, started: Date.now() - 552000, state: 'interrupted', checks: 0 } : null);
      if (!run) throw new UiError(404, 'This run isn’t known to the app. Runs started in the demo are forgotten when it stops.', 'not-found');
      // The simulation advances one step every few seconds.
      const elapsed = Math.floor((Date.now() - run.started) / 1000);
      const step = Math.min(8, Math.floor(elapsed / 3));
      if (run.state === 'running' && step >= 8) run.state = 'finished';
      const steps = offset => [
        { text: 'Copy of the project prepared', state: step > offset ? 'done' : step === offset ? 'active' : 'waiting' },
        { text: step > offset + 1 ? 'Task finished · 4 turns' : 'Working on the task', state: step > offset + 1 ? 'done' : step === offset + 1 ? 'active' : 'waiting' },
        { text: run.checks ? 'Checks' : 'Checks · none selected', state: step > offset + 2 ? 'done' : step === offset + 2 ? 'active' : 'waiting' },
        { text: 'Evidence saved', state: step > offset + 3 ? 'done' : step === offset + 3 ? 'active' : 'waiting' },
      ];
      const stateText = { running: 'Running', finished: 'Finished', cancelled: 'Cancelled', interrupted: 'Interrupted', 'time-limit': 'Time limit reached', 'check-failed': 'A check failed', 'cannot-tidy': 'Can’t tidy up yet' }[run.state];
      const working = step < 4 ? run.a : run.b;
      if (run.state === 'interrupted' && !recoveryPreviews.has(id)) recoveryPreviews.set(id, randomUUID());
      return { id, task: run.task, meta: `${run.a}, then ${run.b} · each in its own copy of [COMMIT] · run ID ${id.slice(0, 8)}`,
        state: run.state, stateText,
        headline: run.state === 'running' ? `Profile ${step < 4 ? 1 : 2} of 2 is working` : run.state === 'finished' ? 'Both profiles finished the task'
          : run.state === 'cancelled' ? `You cancelled during ${working}’s task` : `Xenoflux stopped while ${run.b} was working`,
        elapsed: `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')} so far · stops by 32:00 at the latest`,
        timeUsed: Math.min(1, elapsed / 1920),
        columns: [{ side: 'a', profile: run.a, state: step >= 4 ? 'Done' : 'Working', steps: steps(0) },
          { side: 'b', profile: run.b, state: step >= 8 ? 'Done' : step >= 4 ? 'Working' : 'Waiting', steps: steps(4) }],
        sofar: `So far: ${step * 3} recorded events, ${step} tool uses. Messages and command output aren’t shown here.`,
        reportHref: ['finished', 'cancelled', 'time-limit', 'check-failed'].includes(run.state) ? '/reports/demo-run' : null,
        recovery: run.state === 'interrupted' ? { facts: [`${run.b}’s work has stopped (confirmed)`, 'Keep what was recorded up to turn 3, marked partial', `Free ${run.b} for other use; nothing else is touched`], previewToken: recoveryPreviews.get(id) } : null,
        simulated: true };
    },
    async cancelRun({ id }) {
      const run = runs.get(id);
      if (!run) throw new UiError(404, 'Unknown run.', 'not-found');
      if (run.state === 'running') run.state = 'cancelled';
      return this.run({ id });
    },
    async recoverRun({ id, previewToken }) {
      if (previewToken !== recoveryPreviews.get(id)) throw new UiError(409, 'This recovery preview is stale. Reload the run before tidying up.', 'recovery-stale');
      if (id === 'demo-interrupted') return { id, task: 'Fix the flaky date-parsing test', meta: 'Tidied up (simulated)', state: 'cancelled', stateText: 'Tidied up', headline: 'The record was kept, marked partial',
        elapsed: '', timeUsed: 0, columns: [], sofar: '', reportHref: '/reports/demo-run', recovery: null, simulated: true };
      const run = runs.get(id);
      if (run) run.state = 'cancelled';
      return this.run({ id });
    },
    async copyPlan({ target, from = B, item }) {
      if (!PROFILE_NAMES.includes(target) || target === 'Default') throw new UiError(400, 'Default can be copied from, not into.', 'invalid-target');
      const defs = [
        ['agents', 'AGENTS.md', 'Profile instructions', `Replace ${target}’s with ${from}’s · +2 −1 lines`, 'Shown line by line in the setup comparison.'],
        ['effort', 'model_reasoning_effort', 'Setting', 'medium → high', `Other settings in ${target} stay as they are.`],
        ['review-helper', 'review-helper', 'Skill · exact replacement', 'Update SKILL.md · make scripts/check.sh executable · remove scripts/legacy-lint.sh', `The whole package will match ${from}. Files outside this skill aren’t touched.`],
        ['release-notes', 'release-notes', `Skill · new to ${target}`, 'Add 3 files', 'External tools it calls aren’t installed by copying.'],
      ];
      const clientOpen = clientState[target]?.cli === 'running';
      return { mode: 'copy', source: from, target, title: `Copy from ${from} into ${target}`,
        intro: `Only what you tick changes in ${target}. Everything else stays as it is, and nothing is deleted just because ${from} doesn’t have it.`,
        origin: item ? `Started from ${defs.find(([id]) => id === item)?.[1] ?? item} in the setup comparison. Tick more items if you want them too.` : null,
        items: defs.map(([id, name, kind, change, note]) => ({ id, name, kind, change, note, selected: id === item })),
        manual: [`Plugins and MCP servers aren’t copied. To use mcp_servers.github in ${target}, add it in ${target}’s Codex settings and sign in there. Check first; add only if absent.`],
        never: ['Sign-in and credentials, conversation history, memory, trust and approvals, caches.'],
        blocked: clientOpen ? { title: `${target} is open in Codex CLI.`, body: `Changes can only be applied while it’s closed. Close ${target}’s Terminal session, then apply. Xenoflux asks before closing any Codex app and never closes Terminal sessions for you.` } : null,
        planToken: randomUUID(), simulated: true };
    },
    async copyApply({ target, from, items = [] }) {
      if (!items.length) throw new UiError(400, 'Choose at least one item.', 'nothing-selected');
      if (clientState[target]?.cli === 'running') throw new UiError(409, `${target} is open in Codex CLI. Close it, then apply.`, 'client-open');
      const plan = await this.copyPlan({ target, from });
      const chosen = plan.items.filter(entry => items.includes(entry.id));
      const id = randomUUID();
      copies.set(id, { target, edited: false });
      return { status: 'applied', title: `Copied into ${target} (simulated)`, changes: chosen.map(entry => `${entry.name}: ${entry.change}`),
        note: `Copying doesn’t sign ${target} in or open Codex. Start a fresh conversation in ${target} to use the changes.`,
        undo: { id, explanation: 'Undo restores the replaced files, including scripts/legacy-lint.sh and its permissions. It refuses if you’ve edited them since.' } };
    },
    async copyUndo({ id, simulateEdit }) {
      const copy = copies.get(id);
      if (!copy) throw new UiError(404, 'This copy can’t be found.', 'not-found');
      if (simulateEdit) throw new UiError(409, `AGENTS.md in ${copy.target} was edited after the copy. Undoing would overwrite that edit, so nothing was changed.`, 'undo-refused');
      copies.delete(id);
      return { status: 'undone', title: 'Undone', changes: [], note: `${copy.target} is back to how it was before the copy (simulated).`, undo: null };
    },
    async createPlan({ name = 'careful-tests', from = A }) {
      if (PROFILE_NAMES.includes(name)) throw new UiError(409, `A profile named ${name} already exists.`, 'name-taken');
      return { mode: 'create', source: from, target: name, title: `Create ${name} from parts of ${from}`, intro: `${name} starts with only what you tick. ${from} isn’t changed.`, origin: null,
        items: [['agents', 'AGENTS.md', 'Profile instructions', `Copy ${from}’s instructions`, ''], ['effort', 'model_reasoning_effort', 'Setting', 'medium', 'Settings you don’t tick use Codex’s defaults.'],
          ['review-helper', 'review-helper', 'Skill', 'Copy the whole package · 4 files', 'Includes scripts and their permissions.'], ['pdf-notes', 'pdf-notes', 'Skill', 'Copy the whole package · 2 files', 'External tools it calls aren’t installed by copying.']]
          .map(([id, itemName, kind, change, note]) => ({ id, name: itemName, kind, change, note, selected: false })),
        manual: [`${from}’s docs-tools plugin isn’t copied. To use it in ${name}, install it from Codex after creating the profile.`],
        never: ['Sign-in and credentials, conversation history, memory, trust and approvals, caches.'], blocked: null, planToken: randomUUID(), simulated: true };
    },
    async createApply({ name, from, items = [] }) {
      const plan = await this.createPlan({ name, from });
      const chosen = plan.items.filter(entry => items.includes(entry.id));
      return { status: 'applied', title: `${name} created (simulated)`, changes: chosen.map(entry => `${entry.name}: ${entry.change}`),
        note: 'It has its own settings and no sign-in yet. Open it in Codex to sign in.', undo: null };
    },
    async renameProfile({ name, newName }) { return { status: 'success', message: `Simulated: ${name} would be renamed to ${newName}.` }; },
    async bindProfile({ name, repository }) { return { status: 'success', message: `Simulated: ${name} would be bound to ${repository}.` }; },
    async removeProfile({ name }) { return { status: 'success', message: `Simulated: ${name} would be removed from Xenoflux; its files stay on disk.` }; },
  };
}
