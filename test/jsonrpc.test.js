import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LineSplitter, parseMessage, classify, errorResponse } from '../src/proxy/jsonrpc.js';

test('LineSplitter joins lines split across chunks', () => {
  const lines = [];
  const splitter = new LineSplitter((line) => lines.push(line));
  splitter.push('{"a":1}\n{"b"');
  splitter.push(':2}\n');
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
});

test('LineSplitter handles CRLF and skips empty lines', () => {
  const lines = [];
  const splitter = new LineSplitter((line) => lines.push(line));
  splitter.push('x\r\n\r\ny\n');
  assert.deepEqual(lines, ['x', 'y']);
});

test('LineSplitter flush emits a trailing partial line', () => {
  const lines = [];
  const splitter = new LineSplitter((line) => lines.push(line));
  splitter.push('tail');
  assert.deepEqual(lines, []);
  splitter.flush();
  assert.deepEqual(lines, ['tail']);
});

test('parseMessage returns null for invalid JSON', () => {
  assert.equal(parseMessage('nope'), null);
  assert.deepEqual(parseMessage('{"a":1}'), { a: 1 });
});

test('classify identifies every message kind', () => {
  assert.equal(classify({ jsonrpc: '2.0', id: 1, method: 'x' }), 'request');
  assert.equal(classify({ jsonrpc: '2.0', method: 'x' }), 'notification');
  assert.equal(classify({ jsonrpc: '2.0', id: 1, result: {} }), 'response');
  assert.equal(classify({ jsonrpc: '2.0', id: 1, error: { code: 1, message: 'm' } }), 'error');
  assert.equal(classify(null), 'invalid');
  assert.equal(classify([]), 'invalid');
  assert.equal(classify({}), 'invalid');
});

test('errorResponse builds a JSON-RPC error', () => {
  assert.deepEqual(JSON.parse(errorResponse(7, -32603, 'boom')), {
    jsonrpc: '2.0',
    id: 7,
    error: { code: -32603, message: 'boom' }
  });
  assert.deepEqual(JSON.parse(errorResponse(7, -32603, 'boom', { a: 1 })).error.data, { a: 1 });
});
