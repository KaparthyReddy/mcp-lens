import { EventEmitter } from 'node:events';
import { classify, parseMessage } from './jsonrpc.js';
import { estimateTokens } from '../telemetry/tokens.js';

const OPPOSITE = { c2s: 's2c', s2c: 'c2s' };

export class Session extends EventEmitter {
  constructor({ command, args = [] }) {
    super();
    this.command = command;
    this.args = args;
    this.startedAt = Date.now();
    this.seq = 0;
    this.pending = new Map();
    this.clientInfo = null;
    this.serverInfo = null;
  }

  observe(direction, line, { synthetic = false } = {}) {
    const ts = Date.now();
    const message = parseMessage(line);
    const kind = classify(message);
    const record = {
      seq: ++this.seq,
      ts,
      direction,
      kind,
      bytes: Buffer.byteLength(line, 'utf8'),
      tokens: estimateTokens(line),
      method: null,
      rpcId: null,
      tool: null,
      latencyMs: null,
      requestSeq: null,
      isError: false,
      synthetic,
      message,
      raw: kind === 'invalid' ? line : undefined
    };

    if (kind === 'request' || kind === 'notification') {
      record.method = message.method;
      if (kind === 'request') {
        record.rpcId = message.id;
        if (message.method === 'tools/call') {
          record.tool = message.params?.name ?? null;
        }
        this.pending.set(`${direction}:${message.id}`, {
          seq: record.seq,
          ts,
          method: record.method,
          tool: record.tool
        });
      }
      if (message.method === 'initialize') {
        this.clientInfo = message.params?.clientInfo ?? null;
      }
    } else if (kind === 'response' || kind === 'error') {
      record.rpcId = message.id;
      const key = `${OPPOSITE[direction]}:${message.id}`;
      const origin = this.pending.get(key);
      if (origin) {
        this.pending.delete(key);
        record.method = origin.method;
        record.tool = origin.tool;
        record.requestSeq = origin.seq;
        record.latencyMs = ts - origin.ts;
        if (origin.method === 'initialize' && kind === 'response') {
          this.serverInfo = message.result?.serverInfo ?? null;
        }
      }
      record.isError = kind === 'error' || message.result?.isError === true;
    } else {
      record.isError = true;
    }

    this.emit('record', record);
    return record;
  }

  observeStderr(text) {
    const record = {
      seq: ++this.seq,
      ts: Date.now(),
      direction: 'stderr',
      kind: 'stderr',
      bytes: Buffer.byteLength(text, 'utf8'),
      tokens: 0,
      method: null,
      rpcId: null,
      tool: null,
      latencyMs: null,
      requestSeq: null,
      isError: false,
      synthetic: false,
      message: null,
      text
    };
    this.emit('record', record);
    return record;
  }

  end(code, signal) {
    this.emit('end', {
      code,
      signal,
      durationMs: Date.now() - this.startedAt
    });
  }

  info() {
    return {
      command: this.command,
      args: this.args,
      startedAt: this.startedAt,
      clientInfo: this.clientInfo,
      serverInfo: this.serverInfo
    };
  }
}
