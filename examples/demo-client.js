import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const wait = args.includes('--wait');
const extra = args.filter((arg) => arg !== '--wait');

const child = spawn(
  process.execPath,
  [
    join(root, 'bin', 'mcp-loupe.js'),
    'run',
    ...extra,
    '--',
    process.execPath,
    join(root, 'examples', 'demo-server.js')
  ],
  { stdio: ['pipe', 'pipe', 'inherit'] }
);

const waiting = new Map();
let counter = 0;

createInterface({ input: child.stdout }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const resolve = waiting.get(message.id);
  if (resolve) {
    waiting.delete(message.id);
    resolve(message);
  }
});

const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function request(method, params) {
  const id = ++counter;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, 90000);
    waiting.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

function summarize(message) {
  if (message.error) return `error ${message.error.code}: ${message.error.message}`;
  const result = message.result ?? {};
  const text = result.content?.[0]?.text;
  if (typeof text === 'string') {
    return `${result.isError ? 'ERROR ' : ''}${text.replace(/\s+/g, ' ').slice(0, 70)}`;
  }
  if (result.tools) return `${result.tools.length} tools`;
  if (result.serverInfo) return `server ${result.serverInfo.name}`;
  return 'ok';
}

const call = (name, args) => ['tools/call', { name, arguments: args }];

const steps = [
  ['initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'demo-client', version: '0.1.0' }
  }],
  ['notify', 'notifications/initialized'],
  ['tools/list', {}],
  call('list_notes', {}),
  call('get_note', { id: 'n2' }),
  call('search_notes', { query: 'groceries' }),
  call('save_note', { title: 'Ideas', body: 'Ship mcp-loupe v0.1' }),
  call('run_command', { command: 'ls -la' }),
  call('run_command', { command: 'rm -rf /' }),
  call('get_note', { id: '../../.ssh/id_rsa' }),
  call('export_notes', {}),
  call('fetch_url', { url: 'https://example.com' }),
  call('get_note', { id: 'n99' }),
  call('misc', { x: 1 })
];

try {
  if (wait) {
    await sleep(1500);
    process.stderr.write('\nArrange your windows, start recording, then press Enter here to begin... ');
    await new Promise((resolve) => process.stdin.once('data', resolve));
    process.stdin.pause();
  }

  for (const [method, params] of steps) {
    if (method === 'notify') {
      send({ jsonrpc: '2.0', method: params });
      continue;
    }
    const label = method === 'tools/call' ? `${method} ${params.name}` : method;
    const response = await request(method, params);
    console.log(label.padEnd(28), summarize(response));
    await sleep(400);
  }
} catch (error) {
  console.error(error.message);
}

child.stdin.end();
child.on('close', (code) => process.exit(code ?? 0));