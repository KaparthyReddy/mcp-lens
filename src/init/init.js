import readline from 'node:readline/promises';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findConfigs } from './clients.js';
import { loadPolicy } from '../guard/policy.js';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'mcp-loupe.js');

export function launcher(binPath = BIN) {
  if (binPath.includes(`${sep}_npx${sep}`)) {
    return { command: 'npx', args: ['-y', 'mcp-loupe'] };
  }
  return { command: process.execPath, args: [binPath] };
}

export function isStdioServer(entry) {
  return Boolean(
    entry &&
      typeof entry === 'object' &&
      typeof entry.command === 'string' &&
      entry.command !== '' &&
      !entry.url
  );
}

export function isWrapped(entry) {
  if (!isStdioServer(entry)) return false;
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  return (
    args.includes('run') &&
    args.includes('--') &&
    args.some((arg) => /(^|[\\/])mcp-loupe(\.js)?$/.test(arg))
  );
}

export function wrapEntry(entry, launch, guardPath = null) {
  return {
    ...entry,
    command: launch.command,
    args: [
      ...launch.args,
      'run',
      ...(guardPath ? ['--guard', guardPath] : []),
      '--',
      entry.command,
      ...(Array.isArray(entry.args) ? entry.args : [])
    ]
  };
}

export function unwrapEntry(entry) {
  const args = Array.isArray(entry.args) ? entry.args : [];
  const index = args.indexOf('--');
  if (index === -1 || index + 1 >= args.length) return null;
  return {
    ...entry,
    command: args[index + 1],
    args: args.slice(index + 2)
  };
}

function readConfig(path) {
  const text = readFileSync(path, 'utf8');
  return text.trim() === '' ? {} : JSON.parse(text);
}

export async function runInit(values) {
  const auto = values.yes === true;
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!auto && !interactive) {
    throw new Error(
      'init needs an interactive terminal. use --yes to wrap every stdio server without prompting'
    );
  }

  const rl = auto
    ? null
    : readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = async (question) => (rl ? (await rl.question(question)).trim() : '');
  const confirm = async (question, fallback) => {
    if (!rl) return fallback;
    const answer = (await ask(`${question} ${fallback ? '[Y/n]' : '[y/N]'} `)).toLowerCase();
    if (answer === '') return fallback;
    return answer === 'y' || answer === 'yes';
  };

  try {
    let configs = findConfigs(process.cwd());

    if (configs.length === 0) {
      console.log('no known MCP client config files found.');
      const custom = await ask('path to a config file with an "mcpServers" section (enter to quit): ');
      if (custom && existsSync(resolve(custom))) {
        configs = [{ name: 'custom', path: resolve(custom) }];
      }
    }
    if (configs.length === 0) {
      console.log('nothing to do.');
      return;
    }

    const launch = launcher();
    console.log(`launcher: ${[launch.command, ...launch.args].join(' ')}`);

    let guardPath = null;
    let guardAsked = false;
    const resolveGuard = async () => {
      if (guardAsked || !rl) return guardPath;
      guardAsked = true;
      const answer = await ask('guard policy file to enable the firewall (enter to skip): ');
      if (answer) {
        const absolute = resolve(answer);
        try {
          loadPolicy(absolute);
          guardPath = absolute;
        } catch (error) {
          console.log(`skipping guard: ${error.message}`);
        }
      }
      return guardPath;
    };

    let totalChanges = 0;

    for (const config of configs) {
      console.log(`\n${config.name}: ${config.path}`);

      let data;
      try {
        data = readConfig(config.path);
      } catch (error) {
        console.log(`  cannot parse (${error.message}), skipping`);
        continue;
      }

      const servers = data?.mcpServers;
      if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
        console.log('  no "mcpServers" section, skipping');
        continue;
      }

      let changes = 0;
      for (const [name, entry] of Object.entries(servers)) {
        if (!isStdioServer(entry)) {
          console.log(`  ${name}: remote server, skipped`);
          continue;
        }

        if (isWrapped(entry)) {
          if (await confirm(`  ${name}: already wrapped. unwrap?`, false)) {
            const original = unwrapEntry(entry);
            if (original) {
              servers[name] = original;
              changes++;
              console.log(`  ${name}: unwrapped`);
            } else {
              console.log(`  ${name}: could not unwrap`);
            }
          }
          continue;
        }

        if (await confirm(`  wrap ${name}?`, true)) {
          const guard = await resolveGuard();
          servers[name] = wrapEntry(entry, launch, guard);
          changes++;
          console.log(`  ${name}: wrapped`);
        }
      }

      if (changes === 0) {
        console.log('  no changes');
        continue;
      }

      const backup = `${config.path}.mcp-loupe.bak`;
      if (!existsSync(backup)) copyFileSync(config.path, backup);
      writeFileSync(config.path, JSON.stringify(data, null, 2) + '\n');
      totalChanges += changes;
      console.log(`  saved ${changes} change${changes === 1 ? '' : 's'} (backup: ${backup})`);
    }

    if (totalChanges > 0) {
      console.log('\nrestart the affected clients to apply.');
      console.log('dashboard: http://127.0.0.1:7777 (the next free port when several servers run)');
    }
  } finally {
    rl?.close();
  }
}
