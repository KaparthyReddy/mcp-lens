function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function bucket(map, name) {
  let entry = map.get(name);
  if (!entry) {
    entry = {
      name,
      calls: 0,
      errors: 0,
      latencies: [],
      tokensIn: 0,
      tokensOut: 0,
      bytesIn: 0,
      bytesOut: 0
    };
    map.set(name, entry);
  }
  return entry;
}

function finish(map) {
  return [...map.values()]
    .map((entry) => {
      const sorted = [...entry.latencies].sort((x, y) => x - y);
      const total = sorted.reduce((sum, value) => sum + value, 0);
      return {
        name: entry.name,
        calls: entry.calls,
        errors: entry.errors,
        tokensIn: entry.tokensIn,
        tokensOut: entry.tokensOut,
        bytesIn: entry.bytesIn,
        bytesOut: entry.bytesOut,
        avgLatencyMs: sorted.length ? Math.round(total / sorted.length) : null,
        p95LatencyMs: percentile(sorted, 0.95),
        maxLatencyMs: sorted.length ? sorted[sorted.length - 1] : null
      };
    })
    .sort((x, y) => y.tokensIn + y.tokensOut - (x.tokensIn + x.tokensOut));
}

export function summarize(records) {
  const totals = {
    messages: 0,
    requests: 0,
    bytes: 0,
    tokens: 0,
    errors: 0,
    stderr: 0,
    tokensToServer: 0,
    tokensFromServer: 0
  };
  const tools = new Map();
  const methods = new Map();

  for (const record of records) {
    if (record.kind === 'stderr') {
      totals.stderr++;
      continue;
    }

    totals.messages++;
    totals.bytes += record.bytes;
    totals.tokens += record.tokens;
    if (record.direction === 'c2s') totals.tokensToServer += record.tokens;
    else totals.tokensFromServer += record.tokens;
    if (record.isError) totals.errors++;
    if (record.kind === 'request') totals.requests++;

    if (!record.method) continue;

    const targets = [bucket(methods, record.method)];
    if (record.tool) targets.push(bucket(tools, record.tool));

    for (const target of targets) {
      if (record.kind === 'request') {
        target.calls++;
        target.tokensIn += record.tokens;
        target.bytesIn += record.bytes;
      } else if (record.kind === 'notification') {
        target.calls++;
      } else if (record.kind === 'response' || record.kind === 'error') {
        target.tokensOut += record.tokens;
        target.bytesOut += record.bytes;
        if (record.isError) target.errors++;
        if (record.latencyMs !== null) target.latencies.push(record.latencyMs);
      }
    }
  }

  return {
    totals,
    tools: finish(tools),
    methods: finish(methods)
  };
}
