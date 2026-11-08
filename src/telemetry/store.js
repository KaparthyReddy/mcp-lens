import { EventEmitter } from 'node:events';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class EventStore extends EventEmitter {
  constructor({ maxRecords = 5000, logFile = null } = {}) {
    super();
    this.maxRecords = maxRecords;
    this.records = [];
    this.stream = null;
    if (logFile) {
      mkdirSync(dirname(logFile), { recursive: true });
      this.stream = createWriteStream(logFile, { flags: 'a' });
    }
  }

  add(record) {
    this.records.push(record);
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords);
    }
    if (this.stream) this.stream.write(JSON.stringify(record) + '\n');
    this.emit('record', record);
  }

  since(seq = 0) {
    return this.records.filter((record) => record.seq > seq);
  }

  clear() {
    this.records = [];
    this.emit('clear');
  }

  close() {
    return new Promise((resolve) => {
      if (this.stream) this.stream.end(resolve);
      else resolve();
    });
  }
}
