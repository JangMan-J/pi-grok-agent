import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callableName, createPiToolRoutes, selectPiTools, PI_CORE_TOOL_NAMES, PI_EXTENSION_TOOL_NAMES } from '../src/tool-policy.ts';

const tools = [
  { name: 'read' },            // core: Grok has read_file
  { name: 'grep' },            // core: Grok has grep
  { name: 'symbol_search' },   // pi-lens
  { name: 'module_report' },   // pi-lens
  { name: 'effective_config' }, // pi-lens, no one-off native-overlap entry
  { name: 'codemode' },        // meta-tool: can call other tools
  { name: 'generate_image' },  // Grok has native image tools
  { name: 'intercom' },        // pi-only: no native equivalent
  { name: 'parallel_search' }, // pi-only
];

test('extensions withholds core tools and blocked extension/tool-surface tools, lends the rest', () => {
  const lent = selectPiTools(tools, 'extensions').map((tool) => tool.name);
  assert.deepEqual(lent, ['intercom', 'parallel_search']);
  for (const coreTool of PI_CORE_TOOL_NAMES) assert.ok(!lent.includes(coreTool), `${coreTool} must stay native`);
  for (const piLensTool of PI_EXTENSION_TOOL_NAMES['pi-lens']) assert.ok(!lent.includes(piLensTool), `${piLensTool} belongs to blocked pi-lens`);
  assert.ok(!lent.includes('codemode'), 'codemode is a default-blocked meta-tool');
  assert.ok(!lent.includes('generate_image'), 'generate_image overlaps Grok native image tools');
});

test('custom blocked Pi extensions replace the defaults (unblock defaults, block another extension)', () => {
  const lent = selectPiTools(tools, 'extensions', ['some-other-extension']).map((tool) => tool.name);
  assert.deepEqual(lent, ['symbol_search', 'module_report', 'effective_config', 'codemode', 'generate_image', 'intercom', 'parallel_search']);
});

test('runtime attribution can block every tool from a source/namespace without a static registry entry', () => {
  const attributions = [
    { name: 'runtime_one', sourceInfo: { source: 'npm:my-provider-tools', path: '/x/index.ts' } },
    { name: 'runtime_two', namespaceName: 'mcp__provider', sourceInfo: { source: 'github.com/acme/provider-kit', path: '/x/index.ts' } },
  ];
  const runtimeTools = [...tools, { name: 'runtime_one' }, { name: 'runtime_two' }];
  assert.deepEqual(selectPiTools(runtimeTools, 'extensions', ['my-provider-tools'], attributions).map((tool) => tool.name), [
    'symbol_search', 'module_report', 'effective_config', 'codemode', 'generate_image', 'intercom', 'parallel_search', 'runtime_two',
  ]);
  assert.equal(selectPiTools(runtimeTools, 'extensions', ['mcp__provider'], attributions).some((tool) => tool.name === 'runtime_two'), false);
});

test('all and a named allow-list ignore blocked extensions', () => {
  assert.deepEqual(selectPiTools(tools, 'all').map((tool) => tool.name), tools.map((tool) => tool.name));
  assert.deepEqual(selectPiTools(tools, ['symbol_search', 'read']).map((tool) => tool.name), ['read', 'symbol_search']);
});

test('none lends nothing', () => {
  assert.deepEqual(selectPiTools(tools, 'none'), []);
});

test('every lent tool gets a name Grok admits, and maps back to the Pi tool', () => {
  // Grok admits `pi__<name>` only with one `__`, and only letters, digits, `_`, and `-` in <name>.
  const routes = createPiToolRoutes([{ name: 'intercom' }, { name: 'mcp__docs__search' }, { name: '_private' }, { name: 'docs.search:v2' }, { name: 'mcp_docs_search' }]);
  assert.deepEqual(routes.map((route) => [callableName(route), route.originalName]), [
    ['pi__intercom', 'intercom'],
    ['pi__mcp_docs_search', 'mcp__docs__search'],
    ['pi__private', '_private'],
    ['pi__docs_search_v2', 'docs.search:v2'],
    ['pi__mcp_docs_search_2', 'mcp_docs_search'],
  ]);
  for (const route of routes) assert.match(callableName(route), /^pi__(?!_)(?:(?!__)[A-Za-z0-9_-])+$/);
});
