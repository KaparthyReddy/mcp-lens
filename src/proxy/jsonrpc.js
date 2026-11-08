export class LineSplitter {
  constructor(onLine) {
    this.buffer = '';
    this.onLine = onLine;
  }

  push(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 0) this.onLine(line);
    }
  }

  flush() {
    const line = this.buffer.replace(/\r$/, '');
    this.buffer = '';
    if (line.length > 0) this.onLine(line);
  }
}

export function parseMessage(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function classify(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return 'invalid';
  }
  const hasId = message.id !== undefined && message.id !== null;
  if (typeof message.method === 'string') {
    return hasId ? 'request' : 'notification';
  }
  if ('error' in message) return 'error';
  if ('result' in message) return 'response';
  return 'invalid';
}

export function errorResponse(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return JSON.stringify({ jsonrpc: '2.0', id, error });
}
