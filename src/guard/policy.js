import { readFileSync } from 'node:fs';

const ACTIONS = new Set(['allow', 'ask', 'deny']);
const OPS = new Set(['equals', 'contains', 'startsWith', 'endsWith', 'matches', 'exists']);
const PROMPTS = new Set(['web', 'tty', 'both']);

export function globToRegExp(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function getPath(value, path) {
  if (path === '*') return value;
  let current = value;
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object' || !(key in current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function toText(value) {
  if (typeof value === 'string') return value;
  const text = JSON.stringify(value);
  return text === undefined ? '' : text;
}

function testCondition(condition, args) {
  const value = getPath(args, condition.arg);
  let result;
  if (condition.op === 'exists') {
    result = value !== undefined;
  } else if (value === undefined) {
    result = false;
  } else {
    const text = toText(value);
    switch (condition.op) {
      case 'equals':
        result = text === toText(condition.value);
        break;
      case 'contains':
        result = text.includes(String(condition.value));
        break;
      case 'startsWith':
        result = text.startsWith(String(condition.value));
        break;
      case 'endsWith':
        result = text.endsWith(String(condition.value));
        break;
      case 'matches':
        result = condition.regex.test(text);
        break;
      default:
        result = false;
    }
  }
  return condition.negate ? !result : result;
}

function compileCondition(condition, where) {
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
    throw new Error(`${where}: each condition must be an object`);
  }
  if (typeof condition.arg !== 'string' || condition.arg === '') {
    throw new Error(`${where}: condition needs a non-empty "arg"`);
  }
  if (!OPS.has(condition.op)) {
    throw new Error(`${where}: unknown op "${condition.op}" (use ${[...OPS].join(', ')})`);
  }
  if (condition.op !== 'exists' && condition.value === undefined) {
    throw new Error(`${where}: condition with op "${condition.op}" needs a "value"`);
  }
  const compiled = {
    arg: condition.arg,
    op: condition.op,
    value: condition.value,
    negate: condition.negate === true,
    regex: null
  };
  if (condition.op === 'matches') {
    try {
      compiled.regex = new RegExp(String(condition.value), 'i');
    } catch (error) {
      throw new Error(`${where}: invalid regex: ${error.message}`);
    }
  }
  return compiled;
}

function compileRule(rule, index) {
  const where = `rules[${index}]`;
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    throw new Error(`${where} must be an object`);
  }
  const tools = Array.isArray(rule.tool) ? rule.tool : [rule.tool];
  if (tools.length === 0 || tools.some((tool) => typeof tool !== 'string' || tool === '')) {
    throw new Error(`${where}: "tool" must be a glob string or an array of glob strings`);
  }
  if (!ACTIONS.has(rule.action)) {
    throw new Error(`${where}: "action" must be one of allow, ask, deny`);
  }
  const when = rule.when ?? [];
  if (!Array.isArray(when)) throw new Error(`${where}: "when" must be an array`);
  return {
    name: typeof rule.name === 'string' && rule.name ? rule.name : `rule #${index + 1}`,
    reason: typeof rule.reason === 'string' ? rule.reason : null,
    action: rule.action,
    matchers: tools.map(globToRegExp),
    when: when.map((condition) => compileCondition(condition, where))
  };
}

export function compilePolicy(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('guard policy must be a JSON object');
  }

  const defaultAction = raw.defaultAction ?? 'ask';
  if (!ACTIONS.has(defaultAction)) {
    throw new Error('"defaultAction" must be one of allow, ask, deny');
  }

  const prompt = raw.prompt ?? 'web';
  if (!PROMPTS.has(prompt)) {
    throw new Error('"prompt" must be one of web, tty, both');
  }

  const askTimeoutSeconds = raw.askTimeoutSeconds ?? 60;
  if (typeof askTimeoutSeconds !== 'number' || askTimeoutSeconds <= 0) {
    throw new Error('"askTimeoutSeconds" must be a positive number');
  }

  const approvalPort = raw.approvalPort ?? 7778;
  if (!Number.isInteger(approvalPort) || approvalPort < 1 || approvalPort > 65535) {
    throw new Error('"approvalPort" must be a valid port number');
  }

  if (raw.audit !== undefined && raw.audit !== false && typeof raw.audit !== 'string') {
    throw new Error('"audit" must be a file path string or false');
  }

  const rules = raw.rules ?? [];
  if (!Array.isArray(rules)) throw new Error('"rules" must be an array');

  return {
    defaultAction,
    prompt,
    askTimeoutSeconds,
    approvalPort,
    openBrowser: raw.openBrowser !== false,
    audit: raw.audit,
    rules: rules.map(compileRule)
  };
}

export function evaluate(policy, tool, args) {
  const name = typeof tool === 'string' ? tool : '';
  for (const rule of policy.rules) {
    if (!rule.matchers.some((matcher) => matcher.test(name))) continue;
    if (!rule.when.every((condition) => testCondition(condition, args))) continue;
    return { action: rule.action, rule: rule.name, reason: rule.reason };
  }
  return {
    action: policy.defaultAction,
    rule: null,
    reason: 'no rule matched (default action)'
  };
}

export function loadPolicy(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`cannot read guard policy ${path}: ${error.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`guard policy ${path} is not valid JSON: ${error.message}`);
  }
  return compilePolicy(raw);
}
