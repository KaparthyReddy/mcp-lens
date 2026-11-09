import { spawn } from 'node:child_process';
import { LineSplitter, parseMessage, errorResponse } from './jsonrpc.js';

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

function failClosedReply(line) {
  const message = parseMessage(line);
  if (
    message &&
    typeof message === 'object' &&
    !Array.isArray(message) &&
    message.id !== undefined &&
    message.id !== null
  ) {
    return errorResponse(message.id, -32603, 'mcp-loupe could not evaluate this request');
  }
  return null;
}

export function runStdioProxy({ command, args, session, intercept, onExit }) {
  const child = launch(command, args);

  process.stdin.setEncoding('utf8');
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  let inflight = 0;
  let stdinEnded = false;

  const closeServerInput = () => {
    if (stdinEnded && inflight === 0 && !child.stdin.destroyed) {
      child.stdin.end();
    }
  };

  const writeToServer = (line) => {
    if (!child.stdin.destroyed && child.stdin.writable) {
      child.stdin.write(line + '\n');
    }
  };

  const reportError = (text) => {
    session.observeStderr(text);
    process.stderr.write(text);
  };

  const handleClientLine = async (line) => {
    inflight++;
    try {
      session.observe('c2s', line);
      if (intercept) {
        let reply = null;
        try {
          reply = await intercept(line);
        } catch (error) {
          reportError(`[mcp-loupe] intercept error: ${error.message}\n`);
          reply = failClosedReply(line);
          if (!reply) return;
        }
        if (reply) {
          process.stdout.write(reply + '\n');
          session.observe('s2c', reply, { synthetic: true });
          return;
        }
      }
      writeToServer(line);
    } finally {
      inflight--;
      closeServerInput();
    }
  };

  const handleServerLine = (line) => {
    session.observe('s2c', line);
    process.stdout.write(line + '\n');
  };

  const inbound = new LineSplitter((line) => {
    handleClientLine(line).catch((error) => {
      reportError(`[mcp-loupe] proxy error: ${error.message}\n`);
    });
  });
  const outbound = new LineSplitter(handleServerLine);

  process.stdin.on('data', (chunk) => inbound.push(chunk));
  process.stdin.on('end', () => {
    inbound.flush();
    stdinEnded = true;
    closeServerInput();
  });

  child.stdout.on('data', (chunk) => outbound.push(chunk));
  child.stderr.on('data', (chunk) => {
    session.observeStderr(chunk);
    process.stderr.write(chunk);
  });

  child.stdin.on('error', () => {});

  child.on('error', (error) => {
    reportError(`[mcp-loupe] failed to start "${command}": ${error.message}\n`);
    onExit?.(1);
  });

  child.on('close', (code, signal) => {
    outbound.flush();
    session.end(code, signal);
    onExit?.(code ?? (signal ? 1 : 0));
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }

  return child;
}
