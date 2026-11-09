import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize } from '../telemetry/stats.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8']
};

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(JSON.stringify(body));
}

function listen(server, host, port, attempts = 20) {
  return new Promise((resolve, reject) => {
    const tryPort = (candidate, left) => {
      const onError = (error) => {
        server.removeListener('listening', onListening);
        if (error.code === 'EADDRINUSE' && left > 0) {
          tryPort(candidate + 1, left - 1);
        } else {
          reject(error);
        }
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

export async function startDashboard({
  store,
  session,
  port = 7777,
  host = '127.0.0.1'
}) {
  let boundPort = port;
  let endInfo = null;
  const streams = new Set();

  session.on('end', (info) => {
    endInfo = info;
  });

  const openStream = (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.write('retry: 2000\n\n');

    const send = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onRecord = (record) => send('record', record);
    const onClear = () => send('clear', {});
    const onEnd = (info) => send('end', info);

    store.on('record', onRecord);
    store.on('clear', onClear);
    session.on('end', onEnd);

    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    streams.add(res);

    req.on('close', () => {
      clearInterval(ping);
      store.off('record', onRecord);
      store.off('clear', onClear);
      session.off('end', onEnd);
      streams.delete(res);
    });
  };

  const route = async (req, res) => {
    const hostHeader = req.headers.host ?? '';
    if (
      hostHeader !== `127.0.0.1:${boundPort}` &&
      hostHeader !== `localhost:${boundPort}`
    ) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }

    const url = new URL(req.url, `http://${hostHeader}`);
    const path = url.pathname;

    if (req.method === 'GET' && STATIC[path]) {
      const [file, type] = STATIC[path];
      const body = await readFile(join(PUBLIC_DIR, file));
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(body);
      return;
    }

    if (req.method === 'GET' && path === '/api/session') {
      sendJson(res, 200, { ...session.info(), ended: endInfo });
      return;
    }

    if (req.method === 'GET' && path === '/api/records') {
      const since = Number(url.searchParams.get('since') ?? 0) || 0;
      sendJson(res, 200, store.since(since));
      return;
    }

    if (req.method === 'GET' && path === '/api/stats') {
      sendJson(res, 200, summarize(store.records));
      return;
    }

    if (req.method === 'GET' && path === '/api/export') {
      sendJson(
        res,
        200,
        { session: { ...session.info(), ended: endInfo }, records: store.records },
        { 'Content-Disposition': 'attachment; filename="mcp-loupe-session.json"' }
      );
      return;
    }

    if (req.method === 'GET' && path === '/events') {
      openStream(req, res);
      return;
    }

    if (req.method === 'POST' && path === '/api/clear') {
      const origin = req.headers.origin;
      if (origin && origin !== `http://${hostHeader}`) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
      store.clear();
      sendJson(res, 200, { ok: true });
      return;
    }

    res.writeHead(404);
    res.end('not found');
  };

  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { error: error.message });
      else res.end();
    }
  });

  boundPort = await listen(server, host, port);

  const close = () =>
    new Promise((resolve) => {
      for (const stream of streams) stream.end();
      streams.clear();
      server.close(() => resolve());
      server.closeAllConnections?.();
    });

  return { server, port: boundPort, url: `http://127.0.0.1:${boundPort}`, close };
}
