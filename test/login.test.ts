import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { grokLogin, parseDeviceCode } from '../src/login.ts';

// Output of `grok login --device-auth` from Grok Build 1.0.41, captured without a TTY (the code is from a discarded flow).
const OUTPUT = '\nTo sign in, open this URL in your browser:\n\n  https://accounts.x.ai/oauth2/device?user_code=2KCV-ZF2F\n\nConfirm this code in your browser:\n\n  2KCV-ZF2F\n\n\x1b[90mOnly continue with a code you requested. Don\'t share it with anyone.\x1b[0m\n\nWaiting for authorization...\n';

test('parseDeviceCode reads the URL and code from grok login output', () => {
  assert.deepEqual(parseDeviceCode(OUTPUT), { url: 'https://accounts.x.ai/oauth2/device?user_code=2KCV-ZF2F', code: '2KCV-ZF2F' });
  assert.equal(parseDeviceCode('Waiting for authorization...'), undefined);
});

function fakeGrok(t: import('node:test').TestContext, body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-grok-login-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'grok');
  writeFileSync(bin, `#!/bin/sh\n${body}\n`); chmodSync(bin, 0o755);
  return bin;
}

test('grokLogin reports the code once and resolves when grok login succeeds', async (t) => {
  const binary = fakeGrok(t, `[ "$1 $2" = "login --device-auth" ] || exit 9\nprintf '%s' '${OUTPUT.replace(/'/g, "'\\''")}'\nsleep 0.2\nexit 0`);
  const codes: string[] = [];
  await grokLogin((d) => codes.push(d.code), { binary });
  assert.deepEqual(codes, ['2KCV-ZF2F']);
});

test('grokLogin rejects with Grok\'s last words when the login fails', async (t) => {
  const binary = fakeGrok(t, `echo 'xAI device authorization was denied' >&2\nexit 1`);
  await assert.rejects(grokLogin(() => {}, { binary }), /failed \(exit 1\): xAI device authorization was denied/);
});
