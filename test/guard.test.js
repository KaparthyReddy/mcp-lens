import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGuard } from '../src/guard/index.js';
import { Session } from '../src/proxy/session.js';

const call = (name, id = 1) =>
  JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } });

test('guard allows, denies, and ignores non-tool traffic', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-lens-'));
  const file = join(dir, 'guard.json');
  writeFileSync(
    file,
    JSON.stringify({
      defaultAction: 'deny',
      audit: false,
      rules: [{ tool: 'read_*', action: 'allow' }]
    })
  );

  try {
    const guard = await createGuard({
      policyPath: file,
      session: new Session({ command: 'x' }),
      log() {}
    });

    assert.equal(await guard.intercept(call('read_file')), null);

    const denied = JSON.parse(await guard.intercept(call('write_file', 7)));
    assert.equal(denied.id, 7);
    assert.equal(denied.result.isError, true);
    assert.match(denied.result.content[0].text, /Blocked by mcp-lens guard/);

    assert.equal(
      await guard.intercept(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })),
      null
    );
    assert.equal(await guard.intercept('not json'), null);

    const batch = JSON.parse(await guard.intercept(`[${call('read_file', 3)}]`));
    assert.equal(batch[0].id, 3);
    assert.equal(batch[0].result.isError, true);

    await guard.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
