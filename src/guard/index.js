import { dirname, resolve } from 'node:path';
import { loadPolicy, evaluate } from './policy.js';
import { createAudit } from './audit.js';
import { createApprover } from './prompt.js';
import { parseMessage, errorResponse } from '../proxy/jsonrpc.js';

function blockedResult(id, text) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text }], isError: true }
  });
}

function isToolCall(message) {
  return message && typeof message === 'object' && message.method === 'tools/call';
}

export async function createGuard({ policyPath, session, log }) {
  const policy = loadPolicy(policyPath);
  const baseDir = dirname(resolve(policyPath));
  const auditFile =
    policy.audit === false ? null : resolve(baseDir, policy.audit ?? '.mcp-lens/audit.jsonl');
  const audit = createAudit(auditFile);
  const remembered = new Map();

  const needsApprover =
    policy.defaultAction === 'ask' || policy.rules.some((rule) => rule.action === 'ask');

  let approver = null;
  if (needsApprover) {
    approver = await createApprover({
      mode: policy.prompt,
      timeoutMs: policy.askTimeoutSeconds * 1000,
      port: policy.approvalPort,
      openBrowser: policy.openBrowser,
      log
    });
  }

  log(
    `guard active: ${policy.rules.length} rules, default "${policy.defaultAction}"` +
      (auditFile ? `, audit log ${auditFile}` : '')
  );

  async function decide(name, args) {
    const verdict = evaluate(policy, name, args);
    if (verdict.action !== 'ask') {
      return { action: verdict.action, rule: verdict.rule, reason: verdict.reason, source: 'policy' };
    }

    const memory = remembered.get(name);
    if (memory) {
      return {
        action: memory,
        rule: verdict.rule,
        reason: 'remembered for this session',
        source: 'session'
      };
    }

    const answer = await approver.request({
      tool: name,
      args,
      rule: verdict.rule,
      reason: verdict.reason
    });
    if (answer.remember && typeof name === 'string') {
      remembered.set(name, answer.decision);
    }
    const reason =
      answer.source === 'timeout'
        ? 'approval timed out'
        : answer.decision === 'allow'
          ? 'approved by user'
          : 'denied by user';
    return { action: answer.decision, rule: verdict.rule, reason, source: answer.source };
  }

  function denyText(result) {
    const detail = result.reason ?? (result.rule ? `rule "${result.rule}"` : 'policy');
    return `Blocked by mcp-lens guard: ${detail}.`;
  }

  async function intercept(line) {
    const message = parseMessage(line);
    if (message === null) return null;

    if (Array.isArray(message)) {
      const calls = message.filter(isToolCall);
      if (calls.length === 0) return null;
      for (const call of calls) {
        audit.log({
          tool: call.params?.name,
          arguments: call.params?.arguments ?? {},
          decision: 'deny',
          source: 'policy',
          rule: null,
          reason: 'JSON-RPC batches containing tools/call are not supported'
        });
      }
      const text = 'Blocked by mcp-lens guard: JSON-RPC batches containing tools/call are not supported.';
      const replies = message
        .filter((entry) => entry && typeof entry === 'object' && entry.id !== undefined && entry.id !== null)
        .map((entry) => JSON.parse(blockedResult(entry.id, text)));
      return replies.length > 0 ? JSON.stringify(replies) : errorResponse(null, -32600, text);
    }

    if (!isToolCall(message)) return null;

    const name = message.params?.name;
    const args = message.params?.arguments ?? {};
    const result = await decide(name, args);

    audit.log({
      tool: name,
      arguments: args,
      decision: result.action,
      source: result.source,
      rule: result.rule,
      reason: result.reason
    });

    if (result.action === 'allow') return null;

    const text = denyText(result);
    log(`blocked ${name}: ${result.reason ?? result.rule ?? 'policy'}`);
    if (message.id === undefined || message.id === null) {
      return errorResponse(null, -32600, text);
    }
    return blockedResult(message.id, text);
  }

  async function close() {
    await approver?.close();
    await audit.close();
  }

  return { intercept, close };
}
