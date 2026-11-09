import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { isStdioServer, isWrapped, launcher, unwrapEntry, wrapEntry } from '../src/init/init.js';

const launch = { command: '/usr/bin/node', args: ['/x/bin/mcp-loupe.js'] };

test('wrapEntry puts the original command after --', () => {
  const original = { command: 'npx', args: ['-y', 'server'], env: { A: '1' } };
  const wrapped = wrapEntry(original, launch, null);
  assert.deepEqual(wrapped, {
    command: '/usr/bin/node',
    args: ['/x/bin/mcp-loupe.js', 'run', '--', 'npx', '-y', 'server'],
    env: { A: '1' }
  });
  assert.equal(isWrapped(wrapped), true);
});

test('wrapEntry adds the guard flag before --', () => {
  const wrapped = wrapEntry({ command: 'node', args: ['s.js'] }, launch, '/p/guard.json');
  assert.deepEqual(wrapped.args, [
    '/x/bin/mcp-loupe.js',
    'run',
    '--guard',
    '/p/guard.json',
    '--',
    'node',
    's.js'
  ]);
});

test('unwrapEntry restores the original entry', () => {
  const original = { command: 'npx', args: ['-y', 'server'], env: { A: '1' } };
  assert.deepEqual(unwrapEntry(wrapEntry(original, launch, '/p/guard.json')), original);
});

test('wrapEntry works for entries without args', () => {
  const wrapped = wrapEntry({ command: 'my-server' }, launch, null);
  assert.deepEqual(wrapped.args.slice(-2), ['--', 'my-server']);
  assert.deepEqual(unwrapEntry(wrapped), { command: 'my-server', args: [] });
});

test('isWrapped detects the npx form and ignores plain servers', () => {
  assert.equal(
    isWrapped({ command: 'npx', args: ['-y', 'mcp-loupe', 'run', '--', 'node', 's.js'] }),
    true
  );
  assert.equal(isWrapped({ command: 'npx', args: ['-y', 'server'] }), false);
});

test('isStdioServer rejects remote entries', () => {
  assert.equal(isStdioServer({ command: 'node' }), true);
  assert.equal(isStdioServer({ url: 'https://example.com/mcp' }), false);
  assert.equal(isStdioServer(null), false);
});

test('launcher uses npx only when running from the npx cache', () => {
  const cached = join('home', '.npm', '_npx', 'abc', 'node_modules', 'mcp-loupe', 'bin', 'mcp-loupe.js');
  assert.deepEqual(launcher(cached), { command: 'npx', args: ['-y', 'mcp-loupe'] });
  const local = launcher(join('work', 'mcp-loupe', 'bin', 'mcp-loupe.js'));
  assert.equal(local.command, process.execPath);
});
