import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const MAX_STRING = 1000;
const MAX_ITEMS = 50;
const MAX_DEPTH = 6;

function truncate(value, depth = 0) {
  if (typeof value === 'string') {
    return value.length > MAX_STRING
      ? `${value.slice(0, MAX_STRING)}...[truncated ${value.length - MAX_STRING} chars]`
      : value;
  }
  if (value === null || typeof value !== 'object' || depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ITEMS).map((item) => truncate(item, depth + 1));
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = truncate(item, depth + 1);
  }
  return out;
}

export function createAudit(file) {
  if (!file) {
    return { log() {}, close: () => Promise.resolve() };
  }
  mkdirSync(dirname(file), { recursive: true });
  const stream = createWriteStream(file, { flags: 'a' });
  return {
    log(entry) {
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        ...entry,
        arguments: truncate(entry.arguments)
      });
      stream.write(line + '\n');
    },
    close() {
      return new Promise((resolve) => stream.end(resolve));
    }
  };
}
