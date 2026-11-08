import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { LineSplitter, parseMessage } from '../proxy/jsonrpc.js';

const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
);

function quoteWindows(value) {
  if (value !== '' && !/[\s"&|<>^()%!]/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

function launch(command, args) {
  const options = {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
    windowsHide: true
  };
  if (process.platform === 'win32' && !/\.exe$/i.test(command)) {
    return spawn([command, ...args].map(quoteWindows).join(' '), {
      ...options,
      shell: true
    });
  }
  return spawn(command, args, options);
}

export function introspect({ command, args = [], timeoutMs = 20000 }) {
  return new Promise((resolve, reject) => {
    const child = launch(command, args);
    const pending = new Map();
    const stderrChunks = [];
    let nextId = 1;
    let done = false;
    let timer = null;

    const stderrTail = () => {
      const text = stderrChunks.join('').trim();
      return text ? `\nserver stderr:\n${text.slice(-1500)}` : '';
    };

    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const entry of pending.values()) entry.reject(new Error('session closed'));
      pending.clear();
      try {
        child.stdin.end();
      } catch {}
      try {
        child.kill();
      } catch {}
      if (error) reject(error);
      else resolve(value);
    };

    const write = (message) => {
      if (!child.stdin.destroyed && child.stdin.writable) {
        child.stdin.write(JSON.stringify(message) + '\n');
      }
    };

    const request = (method, params) =>
      new Promise((resolveRequest, rejectRequest) => {
        const id = nextId++;
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest, method });
        write({ jsonrpc: '2.0', id, method, params });
      });

    const splitter = new LineSplitter((line) => {
      const message = parseMessage(line);
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;

      if (typeof message.method === 'string') {
        if (message.id !== undefined && message.id !== null) {
          if (message.method === 'ping') {
            write({ jsonrpc: '2.0', id: message.id, result: {} });
          } else {
            write({
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32601, message: 'method not found' }
            });
          }
        }
        return;
      }

      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) {
        entry.reject(new Error(`${entry.method} failed: ${message.error.message}`));
      } else {
        entry.resolve(message.result);
      }
    });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => splitter.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
    child.stdin.on('error', () => {});

    child.on('error', (error) => {
      finish(new Error(`failed to start "${command}": ${error.message}`));
    });
    child.on('close', (code) => {
      finish(new Error(`server exited (code ${code}) before finishing the handshake${stderrTail()}`));
    });

    timer = setTimeout(() => {
      finish(
        new Error(
          `timed out after ${timeoutMs / 1000}s waiting for the server to answer${stderrTail()}`
        )
      );
    }, timeoutMs);

    (async () => {
      const init = await request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'mcp-lens', version: pkg.version }
      });
      write({ jsonrpc: '2.0', method: 'notifications/initialized' });

      const tools = [];
      let cursor;
      let pages = 0;
      do {
        const result = await request('tools/list', cursor ? { cursor } : {});
        tools.push(...(result?.tools ?? []));
        cursor = result?.nextCursor;
      } while (cursor && ++pages < 50);

      finish(null, {
        serverInfo: init?.serverInfo ?? null,
        protocolVersion: init?.protocolVersion ?? null,
        tools
      });
    })().catch((error) => finish(new Error(`${error.message}${stderrTail()}`)));
  });
}
