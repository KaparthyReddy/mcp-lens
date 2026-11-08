import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../src/proxy/session.js';

const make = () => {
  const session = new Session({ command: 'node', args: [] });
  const records = [];
  session.on('record', (record) => records.push(record));
  return { session, records };
};

test('pairs a response with its request and measures latency', async () => {
  const { session } = make();
  const request = session.observe(
    'c2s',
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'get_note', arguments: { id: 'n1' } }
    })
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  const response = session.observe(
    's2c',
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [] } })
  );

  assert.equal(request.kind, 'request');
  assert.equal(request.tool, 'get_note');
  assert.equal(response.kind, 'response');
  assert.equal(response.method, 'tools/call');
  assert.equal(response.tool, 'get_note');
  assert.equal(response.requestSeq, request.seq);
  assert.ok(response.latencyMs >= 10);
  assert.equal(response.isError, false);
  assert.ok(response.tokens > 0);
});

test('flags tool errors and JSON-RPC errors', () => {
  const { session } = make();
  session.observe('c2s', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'a' } }));
  const toolError = session.observe(
    's2c',
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [] } })
  );
  assert.equal(toolError.isError, true);

  session.observe('c2s', JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'b' } }));
  const rpcError = session.observe(
    's2c',
    JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -32602, message: 'bad' } })
  );
  assert.equal(rpcError.kind, 'error');
  assert.equal(rpcError.isError, true);
});

test('captures client and server info from the handshake', () => {
  const { session } = make();
  session.observe(
    'c2s',
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'demo-client', version: '1' } }
    })
  );
  session.observe(
    's2c',
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { serverInfo: { name: 'demo-server', version: '2' } }
    })
  );
  const info = session.info();
  assert.equal(info.clientInfo.name, 'demo-client');
  assert.equal(info.serverInfo.name, 'demo-server');
});

test('pairs server-initiated requests with client responses', () => {
  const { session } = make();
  session.observe('s2c', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sampling/createMessage' }));
  const response = session.observe('c2s', JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
  assert.equal(response.method, 'sampling/createMessage');
  assert.notEqual(response.latencyMs, null);
});

test('marks invalid lines and keeps the raw text', () => {
  const { session } = make();
  const record = session.observe('c2s', 'not json');
  assert.equal(record.kind, 'invalid');
  assert.equal(record.isError, true);
  assert.equal(record.raw, 'not json');
});

test('records stderr output', () => {
  const { session, records } = make();
  session.observeStderr('boom\n');
  assert.equal(records[0].kind, 'stderr');
  assert.equal(records[0].direction, 'stderr');
  assert.equal(records[0].text, 'boom\n');
  assert.equal(records[0].bytes, 5);
});

test('unmatched responses have no method or latency', () => {
  const { session } = make();
  const record = session.observe('s2c', JSON.stringify({ jsonrpc: '2.0', id: 99, result: {} }));
  assert.equal(record.method, null);
  assert.equal(record.latencyMs, null);
});

test('synthetic flag is preserved', () => {
  const { session } = make();
  const record = session.observe(
    's2c',
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }),
    { synthetic: true }
  );
  assert.equal(record.synthetic, true);
});
