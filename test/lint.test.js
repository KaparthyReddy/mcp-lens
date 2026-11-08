import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintTools, validateArgs } from '../src/eval/lint.js';

const tool = (name, description, schema = {}) => ({
  name,
  description,
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'identifier of the item' } },
    required: ['id'],
    ...schema
  }
});

const rulesOf = (report, index = 0) => report.tools[index].findings.map((item) => item.rule);

test('a well-described tool has no findings', () => {
  const report = lintTools([tool('get_note', 'Fetch the full text of one note by its identifier.')]);
  assert.deepEqual(report.tools[0].findings, []);
  assert.equal(report.summary.errors, 0);
  assert.equal(report.summary.score, 100);
});

test('flags missing descriptions and invalid names as errors', () => {
  const report = lintTools([
    { name: 'no_desc_tool', inputSchema: { type: 'object', properties: {} } },
    tool('bad name!', 'A properly long description for this tool.')
  ]);
  assert.ok(rulesOf(report, 0).includes('missing-description'));
  assert.ok(rulesOf(report, 1).includes('invalid-name'));
  assert.ok(report.summary.errors >= 2);
});

test('flags schema problems', () => {
  const report = lintTools([
    {
      name: 'bad_required',
      description: 'A properly long description for this tool.',
      inputSchema: { type: 'object', properties: {}, required: ['ghost'] }
    },
    { name: 'no_schema', description: 'A properly long description for this tool.' }
  ]);
  assert.ok(rulesOf(report, 0).includes('required-undefined'));
  assert.ok(rulesOf(report, 1).includes('invalid-schema'));
});

test('flags duplicate names on every copy', () => {
  const report = lintTools([
    tool('same_name', 'First description about reading customer records.'),
    tool('same_name', 'Completely different words describing invoices.')
  ]);
  assert.ok(rulesOf(report, 0).includes('duplicate-name'));
  assert.ok(rulesOf(report, 1).includes('duplicate-name'));
});

test('an empty tool list is an error', () => {
  const report = lintTools([]);
  assert.equal(report.global[0].rule, 'no-tools');
  assert.equal(report.summary.errors, 1);
  assert.equal(report.summary.score, 0);
});

test('detects near-duplicate tools', () => {
  const description = 'Return the profile record for a user, looked up by the numeric user identifier.';
  const report = lintTools([tool('get_user', description), tool('fetch_user', description)]);
  assert.equal(report.similar.length, 1);
  assert.ok(rulesOf(report, 0).includes('similar-tools'));
  assert.ok(rulesOf(report, 1).includes('similar-tools'));
});

test('does not flag unrelated tools as similar', () => {
  const report = lintTools([
    tool('get_weather', 'Return the current weather forecast for a city.'),
    tool('send_email', 'Send an email message to a recipient address.')
  ]);
  assert.equal(report.similar.length, 0);
});

const schema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    n: { type: 'integer' },
    mode: { enum: ['a', 'b'] }
  },
  required: ['id'],
  additionalProperties: false
};

test('validateArgs accepts valid arguments', () => {
  assert.deepEqual(validateArgs(schema, { id: 'x', n: 2, mode: 'a' }), []);
});

test('validateArgs reports problems', () => {
  assert.deepEqual(validateArgs(schema, {}), ['missing required "id"']);
  assert.ok(validateArgs(schema, { id: 5 }).some((e) => e.includes('"id": expected string, got number')));
  assert.ok(validateArgs(schema, { id: 'x', n: 1.5 }).some((e) => e.includes('"n": expected integer, got number')));
  assert.ok(validateArgs(schema, { id: 'x', mode: 'c' }).some((e) => e.includes('"mode": must be one of ["a","b"]')));
  assert.ok(validateArgs(schema, { id: 'x', extra: 1 }).some((e) => e.includes('unknown property "extra"')));
  assert.deepEqual(validateArgs(schema, null), ['arguments must be an object']);
});
