import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectPiTools, PI_CORE_TOOLS, PI_SHADOW_TOOLS } from '../src/config.ts';

const tools = [
  { name: 'read' },            // core: Grok has read_file
  { name: 'grep' },            // core: Grok has grep
  { name: 'symbol_search' },   // shadow default: pi-lens vs native
  { name: 'module_report' },   // shadow default
  { name: 'intercom' },        // pi-only: no native equivalent
  { name: 'parallel_search' }, // pi-only
];

test('extensions withholds core and the shadow blacklist, lends the rest', () => {
  const lent = selectPiTools(tools, 'extensions').map((t) => t.name);
  assert.deepEqual(lent, ['intercom', 'parallel_search']);
  for (const core of PI_CORE_TOOLS) assert.ok(!lent.includes(core), `${core} must stay native`);
  for (const shadow of PI_SHADOW_TOOLS) assert.ok(!lent.includes(shadow), `${shadow} shadows a native tool`);
});

test('a custom blacklist replaces the defaults (unblock a default, block a new one)', () => {
  // Drops symbol_search/module_report from the blacklist, adds intercom.
  const lent = selectPiTools(tools, 'extensions', ['intercom']).map((t) => t.name);
  assert.deepEqual(lent, ['symbol_search', 'module_report', 'parallel_search']);
});

test('all and a named allow-list ignore the blacklist', () => {
  assert.deepEqual(selectPiTools(tools, 'all').map((t) => t.name), tools.map((t) => t.name));
  // An explicit name wins even when it is a shadow default.
  assert.deepEqual(selectPiTools(tools, ['symbol_search', 'read']).map((t) => t.name), ['read', 'symbol_search']);
});

test('none lends nothing', () => {
  assert.deepEqual(selectPiTools(tools, 'none'), []);
});
