import { spawn } from 'node:child_process';
import { LineSplitter } from './jsonrpc.js';

export function runStdioProxy({ command, args, session, intercept, onExit }) {
  const child = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    env: process.env
  });

  process.stdin.setEncoding('utf8');
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  const writeToServer = (line) => {
    if (!child.stdin.destroyed && child.stdin.writable) {
      child.stdin.write(line + '\n');
    }
  };

  const handleClientLine = async (line) => {
    session.observe('c2s', line);
    if (intercept) {
      let reply = null;
      try {
        reply = await intercept(line);
      } catch (error) {
        const text = `[mcp-lens] intercept error: ${error.message}\n`;
        session.observeStderr(text);
        process.stderr.write(text);
      }
      if (reply) {
        process.stdout.write(reply + '\n');
        session.observe('s2c', reply, { synthetic: true });
        return;
      }
    }
    writeToServer(line);
  };

  const handleServerLine = (line) => {
    session.observe('s2c', line);
    process.stdout.write(line + '\n');
  };

  const inbound = new LineSplitter(handleClientLine);
  const outbound = new LineSplitter(handleServerLine);

  process.stdin.on('data', (chunk) => inbound.push(chunk));
  process.stdin.on('end', () => {
    inbound.flush();
    if (!child.stdin.destroyed) child.stdin.end();
  });

  child.stdout.on('data', (chunk) => outbound.push(chunk));
  child.stderr.on('data', (chunk) => {
    session.observeStderr(chunk);
    process.stderr.write(chunk);
  });

  child.stdin.on('error', () => {});

  child.on('error', (error) => {
    const text = `[mcp-lens] failed to start "${command}": ${error.message}\n`;
    session.observeStderr(text);
    process.stderr.write(text);
    onExit?.(1);
  });

  child.on('exit', (code, signal) => {
    outbound.flush();
    session.end(code, signal);
    onExit?.(code ?? (signal ? 1 : 0));
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }

  return child;
}
