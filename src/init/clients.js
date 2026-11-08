import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

function configRoot() {
  const os = platform();
  if (os === 'darwin') return join(homedir(), 'Library', 'Application Support');
  if (os === 'win32') {
    return process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  }
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
}

export function knownClients(cwd = process.cwd()) {
  const root = configRoot();
  return [
    {
      name: 'Claude Desktop',
      path: join(root, 'Claude', 'claude_desktop_config.json')
    },
    {
      name: 'Cursor (global)',
      path: join(homedir(), '.cursor', 'mcp.json')
    },
    {
      name: 'Cursor (this project)',
      path: join(cwd, '.cursor', 'mcp.json')
    },
    {
      name: 'Claude Code (this project)',
      path: join(cwd, '.mcp.json')
    },
    {
      name: 'Windsurf',
      path: join(homedir(), '.codeium', 'windsurf', 'mcp_config.json')
    },
    {
      name: 'Cline (VS Code)',
      path: join(
        root,
        'Code',
        'User',
        'globalStorage',
        'saoudrizwan.claude-dev',
        'settings',
        'cline_mcp_settings.json'
      )
    }
  ];
}

export function findConfigs(cwd = process.cwd()) {
  const seen = new Set();
  return knownClients(cwd).filter((client) => {
    if (seen.has(client.path) || !existsSync(client.path)) return false;
    seen.add(client.path);
    return true;
  });
}
