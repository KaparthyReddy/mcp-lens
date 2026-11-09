import http from 'node:http';
import readline from 'node:readline';
import tty from 'node:tty';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { openSync } from 'node:fs';
import { spawn } from 'node:child_process';

const PAGE = new URL('./approve.html', import.meta.url);
const MAX_ARG_TEXT = 4000;

function describeArgs(args) {
  let text;
  try {
    text = JSON.stringify(args, null, 2);
  } catch {
    text = String(args);
  }
  if (text === undefined) text = '{}';
  if (text.length <= MAX_ARG_TEXT) return text;
  return `${text.slice(0, MAX_ARG_TEXT)}\n... (${text.length - MAX_ARG_TEXT} more characters)`;
}

function clean(value, max = 120) {
  return String(value).replace(/[^\x20-\x7e]/g, ' ').replace(/["\\]/g, '').slice(0, max);
}

function notify(title, body) {
  try {
    let child = null;
    if (process.platform === 'darwin') {
      const script = `display notification "${clean(body)}" with title "${clean(title)}"`;
      child = spawn('osascript', ['-e', script], { stdio: 'ignore' });
    } else if (process.platform === 'linux') {
      child = spawn('notify-send', [clean(title), clean(body)], { stdio: 'ignore' });
    }
    child?.on('error', () => {});
  } catch {}
}

function openUrl(url) {
  let command;
  let args;
  if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (process.platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  try {
    spawn(command, args, { stdio: 'ignore', detached: true })
      .on('error', () => {})
      .unref();
  } catch {}
}

function openTty() {
  try {
    const inputPath = process.platform === 'win32' ? 'CONIN$' : '/dev/tty';
    const outputPath = process.platform === 'win32' ? 'CONOUT$' : '/dev/tty';
    const input = new tty.ReadStream(openSync(inputPath, 'r'));
    const output = new tty.WriteStream(openSync(outputPath, 'w'));
    return { input, output };
  } catch {
    return null;
  }
}

function askTty(io, item, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(null);
      return;
    }
    const rl = readline.createInterface({
      input: io.input,
      output: io.output,
      terminal: true
    });
    const finish = (value) => {
      signal.removeEventListener('abort', onAbort);
      rl.close();
      resolve(value);
    };
    const onAbort = () => {
      io.output.write('\n[mcp-loupe] resolved elsewhere\n');
      finish(null);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    io.output.write(`\n[mcp-loupe] approval needed: ${item.tool}\n${describeArgs(item.args)}\n`);
    rl.question(
      '[y] allow once  [n] deny  [a] always allow tool  [d] always deny tool > ',
      (answer) => {
        const key = answer.trim().toLowerCase();
        if (key === 'y') finish({ decision: 'allow', remember: false });
        else if (key === 'a') finish({ decision: 'allow', remember: true });
        else if (key === 'd') finish({ decision: 'deny', remember: true });
        else finish({ decision: 'deny', remember: false });
      }
    );
  });
}

function readBody(req, limit = 10000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer'
  });
  res.end(body);
}

const sendJson = (res, status, body) =>
  send(res, status, JSON.stringify(body), 'application/json; charset=utf-8');

function listen(server, host, port, attempts = 20) {
  return new Promise((resolve, reject) => {
    const tryPort = (candidate, left) => {
      const onError = (error) => {
        server.removeListener('listening', onListening);
        if (error.code === 'EADDRINUSE' && left > 0) tryPort(candidate + 1, left - 1);
        else reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(candidate);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(candidate, host);
    };
    tryPort(port, attempts);
  });
}

export async function createApprover({ mode, timeoutMs, port, openBrowser, log }) {
  const token = randomBytes(16).toString('hex');
  const pending = new Map();
  const host = '127.0.0.1';
  let nextId = 1;
  let boundPort = port;
  let lastPoll = 0;
  let lastOpened = 0;
  let ttyChain = Promise.resolve();

  let useWeb = mode === 'web' || mode === 'both';
  let ttyIo = null;
  if (mode === 'tty' || mode === 'both') {
    ttyIo = openTty();
    if (!ttyIo) {
      log('no terminal available for prompts, using the browser approval page');
      useWeb = true;
    }
  }

  const approvalUrl = () => `http://${host}:${boundPort}/?t=${token}`;

  const settle = (item, result) => {
    if (item.settled) return false;
    item.settled = true;
    clearTimeout(item.timer);
    item.abort.abort();
    pending.delete(item.id);
    item.resolve(result);
    return true;
  };

  const announce = (item) => {
    notify('mcp-loupe guard', `Approval needed for tool ${clean(item.tool, 60)}`);
    const pageOpen = Date.now() - lastPoll < 4000;
    if (!pageOpen && openBrowser && Date.now() - lastOpened > 20000) {
      lastOpened = Date.now();
      openUrl(approvalUrl());
    }
  };

  const handler = async (req, res) => {
    const hostHeader = req.headers.host ?? '';
    if (hostHeader !== `${host}:${boundPort}` && hostHeader !== `localhost:${boundPort}`) {
      send(res, 403, 'forbidden');
      return;
    }
    const url = new URL(req.url, `http://${hostHeader}`);
    if (url.searchParams.get('t') !== token) {
      send(res, 403, 'forbidden');
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      send(res, 200, await readFile(PAGE), 'text/html; charset=utf-8');
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/pending') {
      lastPoll = Date.now();
      sendJson(
        res,
        200,
        [...pending.values()].map((item) => ({
          id: item.id,
          tool: item.tool,
          args: describeArgs(item.args),
          rule: item.rule,
          reason: item.reason,
          expiresAt: item.createdAt + timeoutMs
        }))
      );
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/decide') {
      const origin = req.headers.origin;
      if (origin && origin !== `http://${hostHeader}`) {
        send(res, 403, 'forbidden');
        return;
      }
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        sendJson(res, 400, { error: 'bad request' });
        return;
      }
      const item = pending.get(Number(body?.id));
      if (!item) {
        sendJson(res, 404, { error: 'not pending' });
        return;
      }
      settle(item, {
        decision: body.decision === 'allow' ? 'allow' : 'deny',
        remember: body.remember === true,
        source: 'web'
      });
      sendJson(res, 200, { ok: true });
      return;
    }

    send(res, 404, 'not found');
  };

  let server = null;
  if (useWeb) {
    server = http.createServer((req, res) => {
      handler(req, res).catch((error) => {
        if (!res.headersSent) sendJson(res, 500, { error: error.message });
        else res.end();
      });
    });
    boundPort = await listen(server, host, port);
    log(`guard approvals: ${approvalUrl()}`);
  }

  function request({ tool, args, rule, reason }) {
    return new Promise((resolve) => {
      const item = {
        id: nextId++,
        tool,
        args,
        rule,
        reason,
        createdAt: Date.now(),
        resolve,
        settled: false,
        abort: new AbortController(),
        timer: null
      };
      item.timer = setTimeout(
        () => settle(item, { decision: 'deny', remember: false, source: 'timeout' }),
        timeoutMs
      );
      pending.set(item.id, item);

      if (useWeb) announce(item);

      if (ttyIo) {
        ttyChain = ttyChain.then(async () => {
          if (item.settled) return;
          const answer = await askTty(ttyIo, item, item.abort.signal);
          if (answer) settle(item, { ...answer, source: 'terminal' });
        });
      }
    });
  }

  async function close() {
    for (const item of [...pending.values()]) {
      settle(item, { decision: 'deny', remember: false, source: 'shutdown' });
    }
    if (server) {
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    }
    try {
      ttyIo?.input.destroy();
      ttyIo?.output.destroy();
    } catch {}
  }

  return { request, close, url: useWeb ? approvalUrl() : null };
}
