import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compilePolicy, evaluate, globToRegExp } from '../src/guard/policy.js';

test('globToRegExp supports * and ? and escapes dots', () => {
  assert.ok(globToRegExp('read_*').test('read_file'));
  assert.ok(!globToRegExp('read_*').test('write_file'));
  assert.ok(globToRegExp('a?c').test('abc'));
  assert.ok(globToRegExp('a.c').test('a.c'));
  assert.ok(!globToRegExp('a.c').test('abc'));
});

test('compilePolicy applies defaults', () => {
  const policy = compilePolicy({});
  assert.equal(policy.defaultAction, 'ask');
  assert.equal(policy.prompt, 'web');
  assert.equal(policy.askTimeoutSeconds, 60);
  assert.equal(policy.approvalPort, 7778);
  assert.deepEqual(policy.rules, []);
});

test('compilePolicy rejects invalid policies', () => {
  assert.throws(() => compilePolicy([]), /JSON object/);
  assert.throws(() => compilePolicy({ defaultAction: 'maybe' }), /defaultAction/);
  assert.throws(() => compilePolicy({ prompt: 'carrier-pigeon' }), /prompt/);
  assert.throws(() => compilePolicy({ rules: [{ tool: 'x', action: 'maybe' }] }), /action/);
  assert.throws(
    () => compilePolicy({ rules: [{ tool: 'x', action: 'deny', when: [{ arg: 'a', op: 'bogus', value: 1 }] }] }),
    /unknown op/
  );
  assert.throws(
    () => compilePolicy({ rules: [{ tool: 'x', action: 'deny', when: [{ arg: 'a', op: 'matches', value: '(' }] }] }),
    /invalid regex/
  );
  assert.throws(
    () => compilePolicy({ rules: [{ tool: 'x', action: 'deny', when: [{ arg: 'a', op: 'equals' }] }] }),
    /value/
  );
});

const policy = compilePolicy({
  defaultAction: 'deny',
  rules: [
    { name: 'safe reads', tool: 'read_*', action: 'allow' },
    {
      name: 'danger',
      tool: 'run',
      when: [{ arg: 'cmd', op: 'matches', value: 'rm\\s+-rf' }],
      action: 'deny',
      reason: 'destructive'
    },
    { name: 'run ok', tool: 'run', action: 'allow' }
  ]
});

test('evaluate uses the first matching rule', () => {
  const danger = evaluate(policy, 'run', { cmd: 'rm -rf /' });
  assert.equal(danger.action, 'deny');
  assert.equal(danger.rule, 'danger');
  assert.equal(danger.reason, 'destructive');

  const fine = evaluate(policy, 'run', { cmd: 'ls' });
  assert.equal(fine.action, 'allow');
  assert.equal(fine.rule, 'run ok');

  assert.equal(evaluate(policy, 'read_file', {}).action, 'allow');
});

test('evaluate falls back to the default action', () => {
  const result = evaluate(policy, 'write_file', {});
  assert.equal(result.action, 'deny');
  assert.equal(result.rule, null);
});

test('conditions: equals, contains, startsWith, endsWith, exists', () => {
  const p = compilePolicy({
    defaultAction: 'allow',
    rules: [
      { tool: 't1', action: 'deny', when: [{ arg: 'a', op: 'equals', value: 5 }] },
      { tool: 't2', action: 'deny', when: [{ arg: 'a', op: 'contains', value: 'bad' }] },
      { tool: 't3', action: 'deny', when: [{ arg: 'a', op: 'startsWith', value: '/etc' }] },
      { tool: 't4', action: 'deny', when: [{ arg: 'a', op: 'endsWith', value: '.pem' }] },
      { tool: 't5', action: 'deny', when: [{ arg: 'a', op: 'exists' }] }
    ]
  });
  assert.equal(evaluate(p, 't1', { a: 5 }).action, 'deny');
  assert.equal(evaluate(p, 't1', { a: 6 }).action, 'allow');
  assert.equal(evaluate(p, 't2', { a: 'a bad day' }).action, 'deny');
  assert.equal(evaluate(p, 't3', { a: '/etc/passwd' }).action, 'deny');
  assert.equal(evaluate(p, 't4', { a: 'key.pem' }).action, 'deny');
  assert.equal(evaluate(p, 't5', { a: null }).action, 'deny');
  assert.equal(evaluate(p, 't5', {}).action, 'allow');
});

test('conditions: negate, nested paths, and the * argument', () => {
  const p = compilePolicy({
    defaultAction: 'allow',
    rules: [
      { tool: 'n', action: 'deny', when: [{ arg: 'force', op: 'exists', negate: true }] },
      { tool: 'p', action: 'deny', when: [{ arg: 'a.b', op: 'equals', value: 'x' }] },
      { tool: '*', action: 'deny', when: [{ arg: '*', op: 'matches', value: '\\.ssh' }] }
    ]
  });
  assert.equal(evaluate(p, 'n', {}).action, 'deny');
  assert.equal(evaluate(p, 'n', { force: true }).action, 'allow');
  assert.equal(evaluate(p, 'p', { a: { b: 'x' } }).action, 'deny');
  assert.equal(evaluate(p, 'p', { a: { b: 'y' } }).action, 'allow');
  assert.equal(evaluate(p, 'anything', { path: '/home/u/.ssh/id' }).action, 'deny');
  assert.equal(evaluate(p, 'anything', { path: '/home/u/docs' }).action, 'allow');
});

test('a condition on a missing argument does not match', () => {
  const p = compilePolicy({
    defaultAction: 'allow',
    rules: [{ tool: 't', action: 'deny', when: [{ arg: 'a', op: 'matches', value: '.*' }] }]
  });
  assert.equal(evaluate(p, 't', {}).action, 'allow');
});

test('a rule can list several tool globs', () => {
  const p = compilePolicy({
    defaultAction: 'deny',
    rules: [{ tool: ['list_*', 'get_*'], action: 'allow' }]
  });
  assert.equal(evaluate(p, 'list_items', {}).action, 'allow');
  assert.equal(evaluate(p, 'get_item', {}).action, 'allow');
  assert.equal(evaluate(p, 'drop_item', {}).action, 'deny');
});
