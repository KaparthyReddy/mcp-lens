import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const bin = join(root, 'bin', 'mcp-loupe.js');
const demo = join(root, 'examples', 'demo-server.js');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const run = (args) =>
  spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', cwd: root, timeout: 30000 });

test('prints the version', () => {
  const result = run(['--version']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), pkg.version);
});

test('prints help', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /mcp-loupe run/);
});

test('rejects unknown options', () => {
  const result = run(['--bogus']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown option/);
});

test('lint reads tools from a real server', () => {
  const result = run(['lint', '--json', '--', process.execPath, demo]);
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.summary.tools, 9);
  assert.equal(report.summary.errors, 0);
  assert.ok(report.tools.find((item) => item.name === 'misc').findings.length > 0);
});

test('lint exits 1 when the server cannot start', () => {
  const result = run(['lint', '--', process.execPath, join(root, 'does-not-exist.js')]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /server exited/);
});
