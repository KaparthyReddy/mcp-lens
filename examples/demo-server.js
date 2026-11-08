import { createInterface } from 'node:readline';

const notes = new Map([
  ['n1', { title: 'Groceries', body: 'Milk, eggs, spinach, rice, olive oil.' }],
  ['n2', { title: 'Project ideas', body: 'MCP inspector, agent firewall, tool-definition linter.' }],
  ['n3', { title: 'Reading list', body: 'Designing Data-Intensive Applications, The Pragmatic Programmer.' }],
  ['n4', { title: 'Meeting notes', body: 'Ship the dashboard first. Guard comes after. Eval last.' }],
  ['n5', { title: 'Travel', body: 'Book train tickets for the November trip.' }]
]);
let counter = notes.size;

const tools = [
  {
    name: 'list_notes',
    description: 'List the ids and titles of all saved notes. Use this first to discover which notes exist.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_note',
    description: 'Fetch the full text of one note by its id, for example "n2".',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Note id as returned by list_notes' } },
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'search_notes',
    description: 'Search note titles and bodies for a keyword and return matching notes.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword or phrase to search for' },
        limit: { type: 'integer', description: 'Maximum number of results, default 5' }
      },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    name: 'save_note',
    description: 'Create a new note with a title and body text.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short note title' },
        body: { type: 'string', description: 'Note content' }
      },
      required: ['title', 'body'],
      additionalProperties: false
    }
  },
  {
    name: 'delete_note',
    description: 'Permanently delete a note by its id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Note id to delete' } },
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'run_command',
    description: 'Run a shell command on the host machine. The demo only echoes the command and never executes it.',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Shell command line' } },
      required: ['command'],
      additionalProperties: false
    }
  },
  {
    name: 'fetch_url',
    description: 'Download the contents of a web page. The demo does not touch the network.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Absolute http or https URL' } },
      required: ['url'],
      additionalProperties: false
    }
  },
  {
    name: 'export_notes',
    description: 'Export every note as one large text blob. Returns a lot of data.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'misc',
    description: 'Does misc things.',
    inputSchema: { type: 'object', properties: { x: {} } }
  }
];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const handlers = {
  async list_notes() {
    await wait(30);
    return [...notes].map(([id, note]) => `${id}: ${note.title}`).join('\n');
  },
  async get_note({ id }) {
    await wait(40);
    const note = notes.get(id);
    if (!note) throw new Error(`note ${id} not found`);
    return `${note.title}\n\n${note.body}`;
  },
  async search_notes({ query, limit = 5 }) {
    await wait(150);
    const needle = String(query ?? '').toLowerCase();
    if (!needle) process.stderr.write('warning: empty search query\n');
    const hits = [...notes]
      .filter(([, note]) => `${note.title} ${note.body}`.toLowerCase().includes(needle))
      .slice(0, limit);
    return hits.length
      ? hits.map(([id, note]) => `${id}: ${note.title} - ${note.body}`).join('\n')
      : 'no matches';
  },
  async save_note({ title, body }) {
    await wait(60);
    const id = `n${++counter}`;
    notes.set(id, { title, body });
    return `saved ${id}`;
  },
  async delete_note({ id }) {
    await wait(50);
    if (!notes.delete(id)) throw new Error(`note ${id} not found`);
    return `deleted ${id}`;
  },
  async run_command({ command }) {
    await wait(300);
    return `(demo) would run: ${command}`;
  },
  async fetch_url({ url }) {
    await wait(700);
    return `(demo) would fetch: ${url}`;
  },
  async export_notes() {
    await wait(200);
    const block = [...notes]
      .map(([id, note]) => `${id} | ${note.title} | ${note.body}`)
      .join('\n');
    return Array.from({ length: 40 }, (_, index) => `--- copy ${index + 1} ---\n${block}`).join('\n');
  },
  async misc({ x }) {
    await wait(10);
    return `ok ${x ?? ''}`;
  }
};

let inflight = 0;
let closed = false;

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');

const maybeExit = () => {
  if (closed && inflight === 0) process.exit(0);
};

async function handle(message) {
  const { id, method, params } = message;
  if (id === undefined || id === null) return;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'demo-notes-server', version: '0.1.0' }
      }
    });
    return;
  }

  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }

  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools } });
    return;
  }

  if (method === 'tools/call') {
    const name = params?.name;
    if (typeof name !== 'string' || !Object.hasOwn(handlers, name)) {
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${name}` } });
      return;
    }
    try {
      const text = await handlers[name](params.arguments ?? {});
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
    } catch (error) {
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: error.message }], isError: true }
      });
    }
    return;
  }

  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
}

process.stderr.write('demo-notes-server ready\n');

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stderr.write('warning: ignored invalid JSON\n');
    return;
  }
  inflight++;
  handle(message)
    .catch((error) => process.stderr.write(`error: ${error.message}\n`))
    .finally(() => {
      inflight--;
      maybeExit();
    });
});

rl.on('close', () => {
  closed = true;
  maybeExit();
});
