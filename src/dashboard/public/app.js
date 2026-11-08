const MAX_RECORDS = 5000;
const LARGE_TOKENS = 2000;
const SLOW_MS = 2000;

const TYPE = {
  request: 'req',
  response: 'res',
  error: 'err',
  notification: 'note',
  stderr: 'stderr',
  invalid: 'invalid'
};

const state = {
  records: new Map(),
  view: 'timeline',
  filter: '',
  errorsOnly: false,
  paused: false,
  selected: null,
  stats: null,
  statsDirty: true,
  session: null,
  connected: false,
  queued: false
};

const el = {
  meta: document.getElementById('meta'),
  status: document.getElementById('status'),
  cards: document.getElementById('cards'),
  list: document.getElementById('list'),
  detail: document.getElementById('detail'),
  filter: document.getElementById('filter'),
  errorsOnly: document.getElementById('errorsOnly'),
  pause: document.getElementById('pause'),
  clear: document.getElementById('clear')
};

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));

const fmtTime = (ts) => {
  const d = new Date(ts);
  return `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')}`;
};
const fmtBytes = (n) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const fmtMs = (n) =>
  n === null || n === undefined ? '–' : n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(2)} s`;
const fmtNum = (n) => (n === null || n === undefined ? '–' : n.toLocaleString());

function label(r) {
  if (r.kind === 'stderr') return r.text.trim().split('\n')[0];
  if (r.kind === 'invalid') return 'invalid JSON-RPC';
  const parts = [];
  if (r.method) parts.push(r.method);
  if (r.tool) parts.push(r.tool);
  return parts.length ? parts.join(' · ') : '(unmatched response)';
}

function haystack(r) {
  if (!r._hay) {
    r._hay = [
      label(r),
      r.kind,
      r.text ?? '',
      r.raw ?? '',
      r.message ? JSON.stringify(r.message) : ''
    ].join(' ').toLowerCase();
  }
  return r._hay;
}

function sortedRecords() {
  return [...state.records.values()].sort((a, b) => a.seq - b.seq);
}

function addRecord(record) {
  state.records.set(record.seq, record);
  if (state.records.size > MAX_RECORDS) {
    state.records.delete(state.records.keys().next().value);
  }
  schedule();
}

function schedule() {
  state.statsDirty = true;
  if (state.paused || state.queued) return;
  state.queued = true;
  requestAnimationFrame(() => {
    state.queued = false;
    renderView();
  });
}

function rowHtml(r) {
  const classes = ['row', r.direction];
  if (r.isError) classes.push('error');
  if (r.synthetic) classes.push('synthetic');
  if (r.tokens >= LARGE_TOKENS) classes.push('large');
  if (r.latencyMs !== null && r.latencyMs >= SLOW_MS) classes.push('slow');
  if (r.seq === state.selected) classes.push('selected');
  const arrow = r.direction === 'c2s' ? '→' : r.direction === 's2c' ? '←' : '!';
  const isStderr = r.kind === 'stderr';
  return `<tr class="${classes.join(' ')}" data-seq="${r.seq}">
    <td class="mono dim">${fmtTime(r.ts)}</td>
    <td class="arrow">${arrow}</td>
    <td><span class="badge ${r.kind}">${esc(TYPE[r.kind] ?? r.kind)}</span>${r.synthetic ? '<span class="badge guard">guard</span>' : ''}</td>
    <td class="mono label">${esc(label(r))}</td>
    <td class="mono dim">${esc(r.rpcId ?? '')}</td>
    <td class="num">${fmtBytes(r.bytes)}</td>
    <td class="num tok">${isStderr ? '' : fmtNum(r.tokens)}</td>
    <td class="num lat">${isStderr ? '' : fmtMs(r.latencyMs)}</td>
  </tr>`;
}

function renderTimeline() {
  const needle = state.filter.trim().toLowerCase();
  const rows = sortedRecords()
    .filter((r) => (!state.errorsOnly || r.isError) && (!needle || haystack(r).includes(needle)))
    .slice(-1000);

  if (rows.length === 0) {
    el.list.innerHTML = '<div class="empty">Waiting for MCP traffic…</div>';
    return;
  }

  const wasBottom = el.list.scrollHeight - el.list.scrollTop - el.list.clientHeight < 40;
  el.list.innerHTML = `<table class="grid">
    <thead><tr><th>Time</th><th></th><th>Type</th><th>Method / tool</th><th>Id</th><th class="num">Size</th><th class="num">~Tokens</th><th class="num">Latency</th></tr></thead>
    <tbody>${rows.map(rowHtml).join('')}</tbody>
  </table>`;
  if (wasBottom) el.list.scrollTop = el.list.scrollHeight;
}

function renderStderr() {
  const needle = state.filter.trim().toLowerCase();
  const lines = sortedRecords()
    .filter((r) => r.kind === 'stderr' && (!needle || haystack(r).includes(needle)));
  if (lines.length === 0) {
    el.list.innerHTML = '<div class="empty">No stderr output from the server.</div>';
    return;
  }
  const wasBottom = el.list.scrollHeight - el.list.scrollTop - el.list.clientHeight < 40;
  el.list.innerHTML = `<pre class="stderr">${lines
    .map((r) => `<span class="dim">${fmtTime(r.ts)}</span> ${esc(r.text.replace(/\n$/, ''))}`)
    .join('\n')}</pre>`;
  if (wasBottom) el.list.scrollTop = el.list.scrollHeight;
}

function statsTable(title, rows, emptyText) {
  if (rows.length === 0) return `<h3>${esc(title)}</h3><div class="empty small">${esc(emptyText)}</div>`;
  const max = Math.max(1, ...rows.map((r) => r.tokensIn + r.tokensOut));
  const body = rows.map((r) => {
    const share = Math.round(((r.tokensIn + r.tokensOut) / max) * 100);
    return `<tr>
      <td class="mono">${esc(r.name)}</td>
      <td class="num">${fmtNum(r.calls)}</td>
      <td class="num ${r.errors ? 'bad' : ''}">${fmtNum(r.errors)}</td>
      <td class="num">${fmtMs(r.avgLatencyMs)}</td>
      <td class="num">${fmtMs(r.p95LatencyMs)}</td>
      <td class="num">${fmtMs(r.maxLatencyMs)}</td>
      <td class="num">${fmtNum(r.tokensIn)}</td>
      <td class="num">${fmtNum(r.tokensOut)}</td>
      <td class="barcell"><div class="bar" style="width:${share}%"></div></td>
    </tr>`;
  }).join('');
  return `<h3>${esc(title)}</h3>
  <table class="grid">
    <thead><tr><th>Name</th><th class="num">Calls</th><th class="num">Errors</th><th class="num">Avg</th><th class="num">p95</th><th class="num">Max</th><th class="num">~Tok in</th><th class="num">~Tok out</th><th>Token share</th></tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

function renderTools() {
  if (!state.stats) {
    el.list.innerHTML = '<div class="empty">No data yet.</div>';
    return;
  }
  const needle = state.filter.trim().toLowerCase();
  const pick = (rows) => rows.filter((r) => !needle || r.name.toLowerCase().includes(needle));
  el.list.innerHTML =
    statsTable('Tool calls', pick(state.stats.tools), 'No tools/call traffic yet.') +
    statsTable('Protocol methods', pick(state.stats.methods), 'No traffic yet.');
}

function renderView() {
  if (state.view === 'timeline') renderTimeline();
  else if (state.view === 'stderr') renderStderr();
  else renderTools();
}

function renderCards() {
  if (!state.stats) return;
  const t = state.stats.totals;
  const list = state.stats.methods.find((m) => m.name === 'tools/list');
  const cards = [
    ['Messages', fmtNum(t.messages), ''],
    ['Sent to server', `~${fmtNum(t.tokensToServer)} tok`, ''],
    ['From server', `~${fmtNum(t.tokensFromServer)} tok`, ''],
    ['Data', fmtBytes(t.bytes), ''],
    ['Errors', fmtNum(t.errors), t.errors > 0 ? 'bad' : ''],
    ['Stderr chunks', fmtNum(t.stderr), '']
  ];
  if (list && list.calls > 0 && list.tokensOut > 0) {
    cards.push(['tools/list size', `~${fmtNum(Math.round(list.tokensOut / list.calls))} tok`, '']);
  }
  el.cards.innerHTML = cards
    .map(([name, value, cls]) => `<div class="card"><div class="card-name">${esc(name)}</div><div class="card-value ${cls}">${esc(value)}</div></div>`)
    .join('');
}

function renderMeta() {
  const s = state.session;
  if (!s) return;
  const client = s.clientInfo?.name ?? 'client';
  const server = s.serverInfo?.name ?? 'server';
  const command = [s.command, ...(s.args ?? [])].join(' ');
  el.meta.innerHTML = `<span>${esc(client)} → ${esc(server)}</span><span class="dim mono">${esc(command)}</span>`;
}

function renderStatus() {
  let text = 'live';
  let cls = 'live';
  if (!state.connected) {
    text = 'disconnected';
    cls = 'down';
  } else if (state.session?.ended) {
    const { code, signal, durationMs } = state.session.ended;
    text = `server exited (${signal ?? code}) after ${(durationMs / 1000).toFixed(1)}s`;
    cls = 'ended';
  }
  el.status.textContent = text;
  el.status.className = `status ${cls}`;
}

function renderDetail() {
  const r = state.records.get(state.selected);
  if (!r) {
    el.detail.classList.add('hidden');
    el.detail.innerHTML = '';
    return;
  }
  const response = [...state.records.values()].find((x) => x.requestSeq === r.seq);
  const facts = [
    ['Time', new Date(r.ts).toISOString()],
    ['Direction', r.direction === 'c2s' ? 'client → server' : r.direction === 's2c' ? 'server → client' : 'server stderr'],
    ['Kind', r.kind],
    ['Method', r.method],
    ['Tool', r.tool],
    ['Id', r.rpcId],
    ['Size', fmtBytes(r.bytes)],
    ['Tokens (est.)', r.kind === 'stderr' ? null : fmtNum(r.tokens)],
    ['Latency', fmtMs(r.latencyMs)]
  ].filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== '–');

  const body = r.kind === 'stderr'
    ? r.text
    : r.message
      ? JSON.stringify(r.message, null, 2)
      : r.raw;

  const links = [];
  if (r.requestSeq) links.push(`<a href="#" data-goto="${r.requestSeq}">request #${r.requestSeq}</a>`);
  if (response) links.push(`<a href="#" data-goto="${response.seq}">response #${response.seq}</a>`);
  if (r.synthetic) links.push('<span class="badge guard">synthetic reply from mcp-lens guard</span>');

  el.detail.classList.remove('hidden');
  el.detail.innerHTML = `
    <div class="detail-head"><strong>#${r.seq}</strong><span><button id="copy">Copy</button> <button id="closeDetail">×</button></span></div>
    <dl>${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    ${links.length ? `<div class="links">${links.join(' ')}</div>` : ''}
    <pre class="payload">${esc(body)}</pre>`;
  el.detail._body = body;
}

function select(seq) {
  state.selected = seq;
  renderDetail();
  renderView();
}

async function loadSession() {
  try {
    const res = await fetch('/api/session');
    state.session = await res.json();
    renderMeta();
    renderStatus();
  } catch {}
}

async function loadBacklog() {
  let since = 0;
  for (const seq of state.records.keys()) if (seq > since) since = seq;
  try {
    const res = await fetch(`/api/records?since=${since}`);
    for (const record of await res.json()) addRecord(record);
  } catch {}
}

function connect() {
  const source = new EventSource('/events');
  source.addEventListener('open', () => {
    state.connected = true;
    renderStatus();
    loadBacklog();
    loadSession();
  });
  source.addEventListener('record', (event) => addRecord(JSON.parse(event.data)));
  source.addEventListener('clear', () => {
    state.records.clear();
    state.selected = null;
    renderDetail();
    schedule();
  });
  source.addEventListener('end', () => loadSession());
  source.addEventListener('error', () => {
    state.connected = false;
    renderStatus();
  });
}

document.querySelectorAll('.tab').forEach((button) => {
  button.addEventListener('click', () => {
    state.view = button.dataset.view;
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === button));
    renderView();
  });
});

el.filter.addEventListener('input', () => {
  state.filter = el.filter.value;
  renderView();
});

el.errorsOnly.addEventListener('change', () => {
  state.errorsOnly = el.errorsOnly.checked;
  renderView();
});

el.pause.addEventListener('click', () => {
  state.paused = !state.paused;
  el.pause.textContent = state.paused ? 'Resume' : 'Pause';
  if (!state.paused) renderView();
});

el.clear.addEventListener('click', async () => {
  try {
    await fetch('/api/clear', { method: 'POST' });
  } catch {}
  state.records.clear();
  state.selected = null;
  renderDetail();
  renderView();
});

el.list.addEventListener('click', (event) => {
  const row = event.target.closest('tr[data-seq]');
  if (row) select(Number(row.dataset.seq));
});

el.detail.addEventListener('click', (event) => {
  const target = event.target;
  if (target.id === 'closeDetail') select(null);
  else if (target.id === 'copy') navigator.clipboard?.writeText(el.detail._body ?? '');
  else if (target.dataset.goto) {
    event.preventDefault();
    select(Number(target.dataset.goto));
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.selected !== null) select(null);
});

setInterval(async () => {
  if (!state.statsDirty) return;
  state.statsDirty = false;
  try {
    const res = await fetch('/api/stats');
    state.stats = await res.json();
    renderCards();
    if (state.view === 'tools' && !state.paused) renderView();
  } catch {
    state.statsDirty = true;
  }
  if (!state.session || !state.session.serverInfo || !state.session.clientInfo) {
    loadSession();
  }
}, 1000);

renderView();
connect();
