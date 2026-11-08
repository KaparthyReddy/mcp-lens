import { readFile } from 'node:fs/promises';
import { introspect } from './introspect.js';
import { lintTools, validateArgs } from './lint.js';
import { createRanker } from './similarity.js';
import { listModels, chatWithTools, normalizeBaseUrl } from './ollama.js';

const DEFAULT_MODEL = 'llama3.2:3b';

const SYSTEM_PROMPT =
  'You are a helpful assistant. Use the provided tools when they are needed to fulfil the request. If no tool is relevant, reply directly without calling a tool.';

const SELECTION_FAILURES = new Set([
  'wrong-tool',
  'no-tool-call',
  'unexpected-tool-call',
  'hallucinated-tool',
  'error'
]);

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = (text) => paint(1, text);
const dim = (text) => paint(2, text);
const red = (text) => paint(31, text);
const green = (text) => paint(32, text);
const yellow = (text) => paint(33, text);
const cyan = (text) => paint(36, text);

function requireCommand(command, usage) {
  if (command.length === 0) {
    throw new Error(`missing server command. usage: ${usage}`);
  }
}

function describeServer(info) {
  if (!info?.name) return 'server';
  return info.version ? `${info.name} ${info.version}` : info.name;
}

function badge(severity) {
  if (severity === 'error') return red('error');
  if (severity === 'warn') return yellow('warn ');
  return cyan('info ');
}

function printLint(serverInfo, report) {
  const { summary, tools, global } = report;
  const out = [];
  out.push(bold(`mcp-lens lint · ${describeServer(serverInfo)}`));
  out.push(
    `${summary.tools} tools · ~${summary.totalTokens.toLocaleString()} tokens of definitions (avg ~${summary.avgTokens}, heaviest: ${summary.heaviest ?? 'n/a'})`
  );
  out.push(
    `score ${summary.score}/100 · ${summary.errors} errors · ${summary.warns} warnings · ${summary.infos} notes`
  );
  out.push('');

  for (const item of global) {
    out.push(`${badge(item.severity)} ${item.rule.padEnd(24)} ${item.message}`);
  }
  if (global.length > 0) out.push('');

  const ordered = [...tools].sort((x, y) => x.score - y.score || x.name.localeCompare(y.name));
  const clean = [];
  for (const tool of ordered) {
    if (tool.findings.length === 0) {
      clean.push(tool.name);
      continue;
    }
    out.push(`${bold(tool.name)} ${dim(`(score ${tool.score}, ~${tool.tokens} tokens)`)}`);
    for (const item of tool.findings) {
      out.push(`  ${badge(item.severity)} ${item.rule.padEnd(24)} ${item.message}`);
    }
    out.push('');
  }
  if (clean.length > 0) out.push(green(`no findings: ${clean.join(', ')}`));

  console.log(out.join('\n'));
}

export async function runLint(values, command) {
  requireCommand(command, 'mcp-lens lint -- <command> [args...]');
  const [executable, ...args] = command;
  const { serverInfo, tools } = await introspect({ command: executable, args });
  const report = lintTools(tools);

  if (values.json) {
    console.log(JSON.stringify({ server: serverInfo, ...report }, null, 2));
  } else {
    printLint(serverInfo, report);
  }
  process.exitCode = report.summary.errors > 0 ? 1 : 0;
}

async function loadPrompts(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new Error(`cannot read prompts file ${file}: ${error.message}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`prompts file ${file} is not valid JSON: ${error.message}`);
  }
  const list = Array.isArray(data) ? data : data?.prompts;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('prompts file must contain a non-empty "prompts" array');
  }
  return list.map((item, index) => {
    const where = `prompts[${index}]`;
    if (!item || typeof item !== 'object' || typeof item.prompt !== 'string' || !item.prompt.trim()) {
      throw new Error(`${where}: needs a non-empty "prompt" string`);
    }
    if (item.expectedTool === undefined) {
      throw new Error(`${where}: needs "expectedTool" (a tool name, or null if no tool should be called)`);
    }
    if (item.expectedTool !== null && typeof item.expectedTool !== 'string') {
      throw new Error(`${where}: "expectedTool" must be a string or null`);
    }
    if (
      item.expectedArgs !== undefined &&
      (item.expectedArgs === null || typeof item.expectedArgs !== 'object' || Array.isArray(item.expectedArgs))
    ) {
      throw new Error(`${where}: "expectedArgs" must be an object`);
    }
    return {
      prompt: item.prompt,
      expectedTool: item.expectedTool,
      expectedArgs: item.expectedArgs
    };
  });
}

function hasModel(installed, model) {
  return installed.some((name) => name === model || name === `${model}:latest`);
}

function looseEqual(expected, actual) {
  if (typeof expected === 'string' && typeof actual === 'string') {
    const want = expected.trim().toLowerCase();
    const got = actual.trim().toLowerCase();
    return got === want || got.includes(want);
  }
  return JSON.stringify(expected) === JSON.stringify(actual);
}

function compareArgs(expected, actual) {
  const mismatches = [];
  for (const [key, value] of Object.entries(expected ?? {})) {
    if (!actual || !(key in actual)) {
      mismatches.push(`missing "${key}"`);
    } else if (!looseEqual(value, actual[key])) {
      mismatches.push(`"${key}": expected ${JSON.stringify(value)}, got ${JSON.stringify(actual[key])}`);
    }
  }
  return mismatches;
}

function judge(item, calls, byName) {
  const call = calls[0] ?? null;
  if (item.expectedTool === null) {
    return call
      ? { outcome: 'unexpected-tool-call', detail: `called ${call.name}` }
      : { outcome: 'pass' };
  }
  if (!call) return { outcome: 'no-tool-call', detail: 'answered without calling a tool' };
  if (!byName.has(call.name)) {
    return { outcome: 'hallucinated-tool', detail: `called unknown tool "${call.name}"` };
  }
  if (call.name !== item.expectedTool) {
    return { outcome: 'wrong-tool', detail: `called ${call.name}` };
  }
  const schemaErrors = validateArgs(byName.get(call.name).inputSchema, call.arguments);
  if (schemaErrors.length > 0) {
    return { outcome: 'bad-args', detail: schemaErrors.join('; ') };
  }
  const mismatches = compareArgs(item.expectedArgs, call.arguments);
  if (mismatches.length > 0) {
    return { outcome: 'arg-mismatch', detail: mismatches.join('; ') };
  }
  return { outcome: 'pass' };
}

function summarizeResults(results) {
  const count = (list, test) => list.filter(test).length;
  const total = results.length;
  const selectionOk = count(results, (r) => !SELECTION_FAILURES.has(r.outcome));
  const withTool = results.filter(
    (r) => r.expectedTool !== null && !SELECTION_FAILURES.has(r.outcome)
  );
  const schemaOk = count(withTool, (r) => r.outcome !== 'bad-args');
  const withArgs = withTool.filter((r) => r.expectedArgs && r.outcome !== 'bad-args');
  const argsOk = count(withArgs, (r) => r.outcome !== 'arg-mismatch');
  const passed = count(results, (r) => r.outcome === 'pass');
  const latencies = results.filter((r) => r.ms !== null).map((r) => r.ms);

  const confusionCounts = new Map();
  for (const r of results) {
    if (!SELECTION_FAILURES.has(r.outcome) || r.outcome === 'error') continue;
    const key = `${r.expectedTool ?? '(no tool)'} -> ${r.calledTool ?? '(no tool)'}`;
    confusionCounts.set(key, (confusionCounts.get(key) ?? 0) + 1);
  }

  return {
    total,
    selectionOk,
    withTool: withTool.length,
    schemaOk,
    withArgs: withArgs.length,
    argsOk,
    passed,
    avgMs: latencies.length
      ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)
      : null,
    confusions: [...confusionCounts]
      .map(([pair, times]) => ({ pair, times }))
      .sort((x, y) => y.times - x.times)
  };
}

const pct = (part, whole) => (whole === 0 ? 'n/a' : `${Math.round((part / whole) * 100)}%`);
const row = (label, part, whole) =>
  `${label.padEnd(26)} ${`${part}/${whole}`.padEnd(8)} ${pct(part, whole)}`;

function printEval({ serverInfo, model, items, runs, summary, results, baseline }) {
  const out = [];
  out.push(bold(`mcp-lens eval · ${describeServer(serverInfo)} · model ${model}`));
  out.push(
    dim(
      `${items.length} prompts x ${runs} run${runs === 1 ? '' : 's'} · avg ${summary.avgMs ?? 'n/a'} ms per request`
    )
  );
  out.push('');
  out.push(row('tool selection', summary.selectionOk, summary.total));
  out.push(row('schema-valid arguments', summary.schemaOk, summary.withTool));
  if (summary.withArgs > 0) out.push(row('expected arguments', summary.argsOk, summary.withArgs));
  out.push(bold(row('overall pass', summary.passed, summary.total)));
  if (baseline.total > 0) {
    out.push(dim(row('lexical baseline (no LLM)', baseline.hits, baseline.total)));
  }

  const failing = new Map();
  for (const r of results) {
    if (r.outcome === 'pass') continue;
    const list = failing.get(r.promptIndex) ?? [];
    list.push(r);
    failing.set(r.promptIndex, list);
  }

  if (failing.size === 0) {
    out.push('');
    out.push(green('all prompts passed'));
  } else {
    out.push('');
    out.push(bold('failures'));
    for (const list of failing.values()) {
      const first = list[0];
      const extra = runs > 1 ? ` [${list.length}/${runs} runs failed]` : '';
      out.push(`  ${red('FAIL')} "${first.prompt}"${extra}`);
      out.push(
        `       expected ${first.expectedTool ?? '(no tool)'} · ${first.outcome}${first.detail ? `: ${first.detail}` : ''}`
      );
    }
    if (summary.confusions.length > 0) {
      out.push('');
      out.push(bold('confusions (expected -> got)'));
      for (const item of summary.confusions) out.push(`  ${item.pair}  x${item.times}`);
    }
    out.push('');
    out.push(dim('tip: run "mcp-lens lint -- <server command>" to check descriptions and schemas'));
  }

  console.log(out.join('\n'));
}

export async function runEval(values, command) {
  requireCommand(command, 'mcp-lens eval --prompts <file> -- <command> [args...]');
  if (!values.prompts) {
    throw new Error('missing --prompts <file>. see examples/eval-prompts.json');
  }

  const baseUrl = normalizeBaseUrl(values.ollama);
  const model = values.model ?? DEFAULT_MODEL;
  const runs = Math.max(1, Math.floor(values.runs ?? 1));
  const items = await loadPrompts(values.prompts);

  const installed = await listModels(baseUrl);
  if (!hasModel(installed, model)) {
    throw new Error(
      `model "${model}" is not installed in ollama. run: ollama pull ${model}` +
        (installed.length ? `\ninstalled models: ${installed.join(', ')}` : '')
    );
  }

  const [executable, ...args] = command;
  process.stderr.write('[mcp-lens] reading tools from the server...\n');
  const { serverInfo, tools } = await introspect({ command: executable, args });
  if (tools.length === 0) throw new Error('the server exposes no tools');

  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  for (const item of items) {
    if (item.expectedTool !== null && !byName.has(item.expectedTool)) {
      throw new Error(
        `prompts file expects tool "${item.expectedTool}" which the server does not expose (available: ${[...byName.keys()].join(', ')})`
      );
    }
  }

  const ranker = createRanker(tools);
  const temperature = runs > 1 ? 0.3 : 0;
  const total = items.length * runs;
  const results = [];
  let done = 0;

  for (const [promptIndex, item] of items.entries()) {
    for (let run = 0; run < runs; run++) {
      let calls = [];
      let ms = null;
      let error = null;

      try {
        const reply = await chatWithTools({
          baseUrl,
          model,
          prompt: item.prompt,
          system: SYSTEM_PROMPT,
          tools,
          temperature
        });
        calls = reply.toolCalls;
        ms = reply.ms;
      } catch (caught) {
        if (/does not support tools/i.test(caught.message)) {
          throw new Error(
            `model "${model}" does not support tool calling. try llama3.2:3b or qwen2.5:7b`
          );
        }
        if (done === 0) throw caught;
        error = caught.message;
      }

      const verdict = error ? { outcome: 'error', detail: error } : judge(item, calls, byName);
      results.push({
        promptIndex,
        run,
        prompt: item.prompt,
        expectedTool: item.expectedTool,
        expectedArgs: item.expectedArgs ?? null,
        calledTool: calls[0]?.name ?? null,
        calledArgs: calls[0]?.arguments ?? null,
        ms,
        ...verdict
      });

      done++;
      const shortPrompt = item.prompt.length > 56 ? `${item.prompt.slice(0, 53)}...` : item.prompt;
      process.stderr.write(
        `[${done}/${total}] ${verdict.outcome.padEnd(20)} "${shortPrompt}"${ms !== null ? ` (${ms} ms)` : ''}\n`
      );
    }
  }

  const summary = summarizeResults(results);

  const baselineItems = items.filter((item) => item.expectedTool !== null);
  const baseline = {
    total: baselineItems.length,
    hits: baselineItems.filter((item) => {
      const top = ranker.rank(item.prompt)[0];
      return top && top.score > 0 && top.name === item.expectedTool;
    }).length
  };

  if (values.json) {
    console.log(
      JSON.stringify({ server: serverInfo, model, runs, summary, baseline, results }, null, 2)
    );
  } else {
    printEval({ serverInfo, model, items, runs, summary, results, baseline });
  }
  process.exitCode = summary.passed < summary.total ? 1 : 0;
}
