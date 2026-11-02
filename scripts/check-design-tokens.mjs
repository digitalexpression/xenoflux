#!/usr/bin/env node
// Keep the app's single token source equal to the values DESIGN.md adopts.
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const design = await readFile(join(root, 'DESIGN.md'), 'utf8');
const css = await readFile(join(root, 'web/src/styles/tokens.css'), 'utf8');

const failures = [];
const hex = value => value.toLowerCase();

// Declarations inside the first block that follows each selector.
function block(selectorPattern) {
  const match = css.match(selectorPattern);
  if (!match) throw new Error(`tokens.css has no block for ${selectorPattern}`);
  let depth = 0, start = css.indexOf('{', match.index), index = start;
  for (; index < css.length; index++) {
    if (css[index] === '{') depth++;
    else if (css[index] === '}' && --depth === 0) break;
  }
  const body = css.slice(start + 1, index).replace(/:root[^{]*\{/g, '');
  return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
}
const light = { ...block(/@theme static\s*\{/), ...block(/^:root\s*\{/m) };
const darkExplicit = block(/:root\[data-theme='dark'\]\s*\{/);
const darkSystem = block(/@media \(prefers-color-scheme: dark\)\s*\{/);
const dark = name => darkExplicit[name] ?? light[name];

function expect(name, lightValue, darkValue) {
  if (hex(light[name] ?? '') !== hex(lightValue)) failures.push(`${name} light: DESIGN.md ${lightValue}, tokens.css ${light[name] ?? 'missing'}`);
  if (darkValue && hex(dark(name) ?? '') !== hex(darkValue)) failures.push(`${name} dark: DESIGN.md ${darkValue}, tokens.css ${dark(name) ?? 'missing'}`);
}

// Color, side and supporting tables: | Name | Light | Dark | `--token` | Role |
for (const [, a, b, token] of design.matchAll(/^\|[^|\n]*\|\s*`(#[0-9a-f]{6})`\s*\|\s*`(#[0-9a-f]{6})`\s*\|\s*`(--[\w-]+)`\s*\|/gmi)) expect(token, a, b);
// Supporting tokens: | `--a` / `--b` | `#x` / `#y` | `#x` / `#y` | Role |
for (const [, tokens, lights, darks] of design.matchAll(/^\|\s*(`--[\w-]+`(?:\s*\/\s*`--[\w-]+`)*)\s*\|\s*((?:`#[0-9a-f]{6}`\s*\/?\s*)+)\|\s*((?:`#[0-9a-f]{6}`\s*\/?\s*)+)\|/gmi)) {
  const names = [...tokens.matchAll(/`(--[\w-]+)`/g)].map(m => m[1]);
  const [l, d] = [lights, darks].map(text => [...text.matchAll(/`(#[0-9a-f]{6})`/gi)].map(m => m[1]));
  names.forEach((name, i) => expect(name, l[i], d[i]));
}
// Status table: | Success | `#fg` / `#bg` | `#fg` / `#bg` | Meaning |
for (const [, status, lf, lb, df, db] of design.matchAll(/^\|\s*(Success|Warning|Error|Neutral)[^|]*\|\s*`(#\w+)`\s*\/\s*`(#\w+)`\s*\|\s*`(#\w+)`\s*\/\s*`(#\w+)`\s*\|/gm)) {
  const key = status.toLowerCase();
  expect(`--color-${key}`, lf, df);
  expect(`--surface-${key}`, lb, db);
}
// Destructive fills from Interaction States.
const destructive = design.match(/light-theme fills `(#\w+)` \/ `(#\w+)` \/ `(#\w+)`.*?Dark-theme fills are `(#\w+)` \/ `(#\w+)` \/ `(#\w+)`/s);
if (!destructive) failures.push('DESIGN.md destructive fills not found');
else ['', '-hover', '-pressed'].forEach((suffix, i) => expect(`--color-destructive${suffix}`, destructive[i + 1], destructive[i + 4]));

// Spacing, radius and layout values in px.
for (const [, value, token] of design.matchAll(/^\|[^|\n]*\|\s*(\d+)px\s*\|\s*`(--(?:space|radius)-[\w-]+)`\s*\|/gm))
  if (light[token] !== `${value}px`) failures.push(`${token}: DESIGN.md ${value}px, tokens.css ${light[token] ?? 'missing'}`);
for (const [token, px] of [['--content-max', 1152], ['--control-height', 40], ['--page-gutter', 24], ['--panel-padding', 24]])
  if (light[token] !== `${px}px`) failures.push(`${token}: expected ${px}px, tokens.css ${light[token] ?? 'missing'}`);
// Type scale: | Role | 32px / 1.2 ... | weight | `--text-x` |; a 13–14px range uses its 14px default.
for (const [, low, high, line, token] of design.matchAll(/^\|[^|\n]*\|\s*(\d+)(?:–(\d+))?px[^|/]*\/\s*([\d.]+)[^|]*\|[^|]*\|\s*`(--text-[\w-]+)`/gm)) {
  const px = high ?? low, rem = `${Number(px) / 16}rem`;
  if (light[token] !== rem) failures.push(`${token}: DESIGN.md ${px}px (${rem}), tokens.css ${light[token] ?? 'missing'}`);
  if (light[`${token}--line-height`] !== line) failures.push(`${token} line height: DESIGN.md ${line}, tokens.css ${light[`${token}--line-height`] ?? 'missing'}`);
}

// Both dark blocks must declare the same values.
for (const name of new Set([...Object.keys(darkExplicit), ...Object.keys(darkSystem)]))
  if (darkExplicit[name] !== darkSystem[name]) failures.push(`${name}: system dark ${darkSystem[name] ?? 'missing'} differs from explicit dark ${darkExplicit[name] ?? 'missing'}`);

if (failures.length) {
  process.stderr.write(`Design tokens differ from DESIGN.md:\n${failures.map(f => `  ${f}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`Design tokens match DESIGN.md (${Object.keys(light).length} light, ${Object.keys(darkExplicit).length} dark declarations).\n`);
