import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Session } from './proxy/session.js';
import { runStdioProxy } from './proxy/stdio.js';
import { EventStore } from './telemetry/store.js';
import { startDashboard } from './dashboard/server.js';

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
);

const COMMANDS = new Set(['run', 'lint', 'eval', 'init', 'help', 'version']);

const SPEC = {
  port: 'number',
  guard: 'string',
  log: 'string',
  open: 'boolean',
  hold: 'boolean',
  'no-dashboard': 'boolean',
  prompts: 'string',
  model: 'string',
  ollama: 'string',
  runs: 'number',
  json: 'boolean',
  yes: 'boolean',
  version: 'boolean',
  help: 'boolean'
};

const ALIASES = {
  '-h': '--help',
  '-v': '--version',
  '-p': '--port',
  '-y': '--yes'
};

const log = (message) => process.stderr.write(`[mcp-lens] ${message}\n`);

function fail(message) {
  log(message);
  process.exit(1);
}

function splitArgv(argv) {
  const index = argv.indexOf('--');
  if (index === -1) return { options: [...argv], command: [] };
  return { options: argv.slice(0, index), command: argv.slice(index + 1) };
}

function parseOptions(list) {
  const values = {};
  const rest = [];
  for (let i = 0; i < list.length; i++) {
    const token = ALIASES[list[i]] ?? list[i];
    if (!token.startsWith('--')) {
      rest.push(token);
      continue;
    }
    let name = token.slice(2);
    let inline;
    const eq = name.indexOf('=');
    if (eq !== -1) {
      inline = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    const type = SPEC[name];
    if (!type) throw new Error(`unknown option --${name}`);
    if (type === 'boolean') {
      values[name] = inline === undefined ? true : inline !== 'false';
      continue;
    }
    const raw = inline !== undefined ? inline : list[++i];
    if (raw === undefined) throw new Error(`option --${name} needs a value`);
    if (type === 'number') {
      const number = Number(raw);
      if (!Number.isFinite(number)) {
        throw new Error(`option --${name} needs a number`);
      }
      values[name] = number;
    } else {
      values[name] = raw;
    }
  }
  return { values, rest };
}

function printHelp() {
  process.stdout.write(`mcp-lens ${pkg.version}

Observe, guard, and evaluate MCP servers.

Usage
  mcp-lens run [options] -- <command> [args...]
  mcp-lens lint [options] -- <command> [args...]
  mcp-lens eval --prompts <file> [options] -- <command> [args...]
  mcp-lens init [--yes]

Options
  -p, --port <n>      dashboard port (default 7777)
      --open          open the dashboard in a browser
      --no-dashboard  disable the dashboard
      --hold          keep the dashboard running after the server exits
      --guard <file>  enable the policy firewall with a guard policy file
      --log <file>    append every message to a JSONL file
      --prompts <f>   eval prompts file
      --model <name>  ollama model used by eval
      --ollama <url>  ollama base url (default http://127.0.0.1:11434)
      --runs <n>      eval runs per prompt
      --json          machine-readable lint output
  -y, --yes           init: apply changes without prompting
  -v, --version
  -h, --help

Client config example
  "command": "npx",
  "args": ["-y", "mcp-lens", "run", "--", "node", "server.js"]
`);
}

function openBrowser(url) {
  const platform = process.platform;
  let command;
  let args;
  if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  try {
    spawn(command, args, { stdio: 'ignore', detached: true })
      .on('error', () => {})
      .unref();
  } catch {}
}

async function runCommand(values, command) {
  if (command.length === 0) {
    fail('missing server command. usage: mcp-lens run [options] -- <command> [args...]');
  }
  const [executable, ...args] = command;

  const session = new Session({ command: executable, args });
  const store = new EventStore({ logFile: values.log ?? null });
  session.on('record', (record) => store.add(record));

  let intercept;
  if (values.guard) {
    const { createGuard } = await import('./guard/index.js');
    const guard = await createGuard({ policyPath: values.guard, session, log });
    intercept = guard.intercept;
  }

  let dashboard = null;
  if (!values['no-dashboard']) {
    try {
      dashboard = await startDashboard({
        store,
        session,
        port: values.port ?? 7777
      });
      log(`dashboard: ${dashboard.url}`);
      if (values.open) openBrowser(dashboard.url);
    } catch (error) {
      log(`dashboard unavailable: ${error.message}`);
    }
  }

  let exited = false;
  runStdioProxy({
    command: executable,
    args,
    session,
    intercept,
    onExit: async (code) => {
      if (exited) return;
      exited = true;
      process.exitCode = code;
      await store.close();
      if (values.hold && dashboard) {
        log(`server exited with code ${code}. dashboard still running at ${dashboard.url}. press Ctrl+C to quit.`);
        process.on('SIGINT', () => process.exit(code));
        return;
      }
      await dashboard?.close();
      process.stdin.destroy();
      setTimeout(() => process.exit(code), 500).unref();
    }
  });
}

export async function main(argv) {
  const { options, command } = splitArgv(argv);

  let sub = 'run';
  if (options.length > 0 && COMMANDS.has(options[0])) {
    sub = options.shift();
  } else if (options.length === 0 && command.length === 0) {
    sub = 'help';
  }

  let parsed;
  try {
    parsed = parseOptions(options);
  } catch (error) {
    fail(error.message);
  }
  const { values, rest } = parsed;

  if (values.version || sub === 'version') {
    process.stdout.write(`${pkg.version}\n`);
    return;
  }
  if (values.help || sub === 'help') {
    printHelp();
    return;
  }

  if (command.length === 0 && rest.length > 0 && sub !== 'init') {
    fail(`unexpected argument "${rest[0]}". put the server command after "--"`);
  }

  try {
    switch (sub) {
      case 'run':
        await runCommand(values, command);
        break;
      case 'lint': {
        const { runLint } = await import('./eval/runner.js');
        await runLint(values, command);
        break;
      }
      case 'eval': {
        const { runEval } = await import('./eval/runner.js');
        await runEval(values, command);
        break;
      }
      case 'init': {
        const { runInit } = await import('./init/init.js');
        await runInit(values);
        break;
      }
    }
  } catch (error) {
    fail(error.message);
  }
}
