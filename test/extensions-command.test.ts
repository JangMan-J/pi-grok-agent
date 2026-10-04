import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleExtensionsCommand } from '../src/model/extensions-command.ts';
import { DEFAULT_BLOCKED_PI_EXTENSIONS } from '../src/tool-policy.ts';

test('/grok extensions list shows user blocks and unblocked package defaults', async () => {
  const blockedPiExtensions = new Set(DEFAULT_BLOCKED_PI_EXTENSIONS);
  blockedPiExtensions.delete('pi-lens');
  blockedPiExtensions.add('some-extension');
  const shown: { title: string; body: string }[] = [];
  await handleExtensionsCommand({
    args: ['list'],
    blockedPiExtensions,
    piTools: 'extensions',
    show: (title, body) => shown.push({ title, body }),
    notify: () => assert.fail('list must not notify'),
    persistBlockedPiExtensions: async () => assert.fail('list must not persist'),
  });
  assert.equal(shown[0]?.title, 'Grok blocked Pi extensions');
  assert.match(shown[0].body, /Active for new Grok sessions under piTools: extensions\./);
  assert.match(shown[0].body, /added by you: some-extension/);
  assert.match(shown[0].body, /unblocked package defaults: pi-lens/);
});

test('/grok extensions unblock persists an authoritative blockedPiExtensions list without the default', async () => {
  const blockedPiExtensions = new Set(DEFAULT_BLOCKED_PI_EXTENSIONS);
  const persisted: string[][] = [];
  const notifications: string[] = [];
  await handleExtensionsCommand({
    args: ['unblock', 'pi-lens'],
    blockedPiExtensions,
    piTools: 'extensions',
    show: () => assert.fail('unblock must not render a list'),
    notify: (message) => notifications.push(message),
    persistBlockedPiExtensions: async (names) => { persisted.push(names); },
  });
  assert.equal(blockedPiExtensions.has('pi-lens'), false);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].includes('pi-lens'), false, 'persisted list replaces defaults, so an unblocked default is omitted');
  assert.deepEqual(persisted[0], [...persisted[0]].sort((a, b) => a.localeCompare(b)));
  assert.match(notifications[0], /unblocked pi-lens/);
  assert.match(notifications[0], /applies to the next Grok session/);
});

test('/grok extensions list says when the block list is inactive', async () => {
  const shown: { title: string; body: string }[] = [];
  await handleExtensionsCommand({
    args: ['list'],
    blockedPiExtensions: new Set(DEFAULT_BLOCKED_PI_EXTENSIONS),
    piTools: 'all',
    show: (title, body) => shown.push({ title, body }),
    notify: () => assert.fail('list must not notify'),
    persistBlockedPiExtensions: async () => assert.fail('list must not persist'),
  });
  assert.match(shown[0].body, /Inactive while piTools is all; every Pi tool is lent\./);
});

test('/grok extensions block persists a user-blocked Pi extension', async () => {
  const blockedPiExtensions = new Set(['pi-lens']);
  const persisted: string[][] = [];
  const notifications: string[] = [];
  await handleExtensionsCommand({
    args: ['block', 'some-extension'],
    blockedPiExtensions,
    piTools: 'all',
    show: () => assert.fail('block must not render a list'),
    notify: (message) => notifications.push(message),
    persistBlockedPiExtensions: async (names) => { persisted.push(names); },
  });
  assert.deepEqual(persisted, [['pi-lens', 'some-extension']]);
  assert.match(notifications[0], /currently ignored by piTools: all/);
});
