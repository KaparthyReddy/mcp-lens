import { estimateValueTokens } from '../telemetry/tokens.js';
import { similarTools } from './similarity.js';

const WEIGHT = { error: 25, warn: 10, info: 2 };
const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const TYPE_KEYS = ['type', 'enum', 'const', 'anyOf', 'oneOf', 'allOf', '$ref'];
const SIMILARITY_THRESHOLD = 0.5;

const GENERIC_NAMES = new Set([
  'run', 'do', 'tool', 'execute', 'exec', 'misc', 'helper', 'process',
  'handle', 'action', 'call', 'main', 'test', 'function', 'fn', 'util',
  'utils', 'task'
]);

const VAGUE_WORDS =
  /\b(misc|miscellaneous|stuff|things?|various|helper|utilit(?:y|ies)|generic|whatever|etc)\b/i;

function finding(severity, rule, message) {
  return { severity, rule, message };
}

function normalizeWords(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function lintTool(tool) {
  const findings = [];
  const name = typeof tool?.name === 'string' ? tool.name : '';
  const description = typeof tool?.description === 'string' ? tool.description.trim() : '';

  if (!name) {
    findings.push(finding('error', 'invalid-name', 'tool has no name'));
  } else if (!NAME_PATTERN.test(name)) {
    findings.push(
      finding(
        'error',
        'invalid-name',
        `"${name}" should use only letters, digits, "_" and "-" and be at most 64 characters; model APIs commonly reject other names`
      )
    );
  } else if (GENERIC_NAMES.has(name.toLowerCase())) {
    findings.push(
      finding(
        'warn',
        'generic-name',
        `"${name}" is too generic for a model to pick reliably; name the action and the object`
      )
    );
  }

  if (!description) {
    findings.push(
      finding('error', 'missing-description', 'no description; the model only has the name to go on')
    );
  } else {
    const words = description.split(/\s+/).length;
    if (words < 4 || description.length < 20) {
      findings.push(
        finding(
          'warn',
          'short-description',
          `only ${words} words; say what it does, what it returns, and when to use it`
        )
      );
    }
    const vague = description.match(VAGUE_WORDS);
    if (vague) {
      findings.push(
        finding('warn', 'vague-description', `vague wording "${vague[0]}"; be specific about what the tool does`)
      );
    }
    if (description.length > 1200) {
      findings.push(
        finding(
          'warn',
          'long-description',
          `${description.length} characters; long descriptions cost tokens on every request`
        )
      );
    } else if (description.length > 600) {
      findings.push(
        finding('info', 'long-description', `${description.length} characters; consider trimming`)
      );
    }
    if (name && normalizeWords(description) === normalizeWords(name)) {
      findings.push(
        finding('warn', 'description-repeats-name', 'description only repeats the tool name')
      );
    }
  }

  const schema = tool?.inputSchema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    findings.push(finding('error', 'invalid-schema', 'inputSchema is missing or not an object'));
    return findings;
  }

  if (schema.type !== undefined && schema.type !== 'object') {
    findings.push(
      finding(
        'error',
        'invalid-schema',
        `inputSchema.type must be "object" (got ${JSON.stringify(schema.type)})`
      )
    );
  }

  let properties = {};
  if (schema.properties !== undefined) {
    if (
      schema.properties &&
      typeof schema.properties === 'object' &&
      !Array.isArray(schema.properties)
    ) {
      properties = schema.properties;
    } else {
      findings.push(finding('error', 'invalid-schema', 'inputSchema.properties must be an object'));
    }
  }
  const keys = Object.keys(properties);

  if (Array.isArray(schema.required)) {
    const missing = schema.required.filter((key) => !(key in properties));
    if (missing.length > 0) {
      findings.push(
        finding('error', 'required-undefined', `required lists undefined properties: ${missing.join(', ')}`)
      );
    }
  } else if (schema.required !== undefined) {
    findings.push(finding('error', 'invalid-schema', 'inputSchema.required must be an array'));
  }

  const undocumented = keys.filter((key) => {
    const description = properties[key]?.description;
    return !(typeof description === 'string' && description.trim());
  });
  if (undocumented.length > 0) {
    findings.push(
      finding(
        'warn',
        'param-description',
        `${undocumented.length} of ${keys.length} parameters have no description: ${undocumented.join(', ')}`
      )
    );
  }

  const untyped = keys.filter((key) => {
    const spec = properties[key];
    return !spec || typeof spec !== 'object' || !TYPE_KEYS.some((field) => field in spec);
  });
  if (untyped.length > 0) {
    findings.push(
      finding('warn', 'param-type', `parameters without a type: ${untyped.join(', ')}`)
    );
  }

  if (keys.length > 10) {
    findings.push(
      finding('warn', 'many-parameters', `${keys.length} parameters; models get less reliable as schemas grow`)
    );
  }

  return findings;
}

export function lintTools(tools) {
  const list = Array.isArray(tools) ? tools : [];

  const results = list.map((tool) => ({
    name: typeof tool?.name === 'string' && tool.name ? tool.name : '(unnamed)',
    tokens: estimateValueTokens(tool),
    findings: lintTool(tool)
  }));

  const byName = new Map();
  results.forEach((result, index) => {
    const indexes = byName.get(result.name) ?? [];
    indexes.push(index);
    byName.set(result.name, indexes);
  });
  for (const [name, indexes] of byName) {
    if (indexes.length > 1 && name !== '(unnamed)') {
      for (const index of indexes) {
        results[index].findings.push(
          finding('error', 'duplicate-name', `${indexes.length} tools share the name "${name}"`)
        );
      }
    }
  }

  const similar = similarTools(list, SIMILARITY_THRESHOLD);
  for (const pair of similar) {
    results[pair.indexA].findings.push(
      finding(
        'warn',
        'similar-tools',
        `very similar to "${pair.b}" (similarity ${pair.score.toFixed(2)}); models may confuse them, so state when to use each`
      )
    );
    results[pair.indexB].findings.push(
      finding(
        'warn',
        'similar-tools',
        `very similar to "${pair.a}" (similarity ${pair.score.toFixed(2)}); models may confuse them, so state when to use each`
      )
    );
  }

  const totalTokens = results.reduce((sum, result) => sum + result.tokens, 0);
  const global = [];
  if (list.length === 0) {
    global.push(finding('error', 'no-tools', 'the server returned no tools'));
  }
  if (list.length > 20) {
    global.push(
      finding(
        'warn',
        'too-many-tools',
        `${list.length} tools; large tool sets hurt selection accuracy and use context, so consider splitting or filtering`
      )
    );
  }
  if (totalTokens > 4000) {
    global.push(
      finding(
        'info',
        'token-budget',
        `tool definitions total about ${totalTokens.toLocaleString()} tokens and are typically sent to the model with every request`
      )
    );
  }

  const scored = results.map((result) => {
    const penalty = result.findings.reduce((sum, item) => sum + WEIGHT[item.severity], 0);
    return { ...result, score: Math.max(0, 100 - penalty) };
  });

  const all = [...global, ...scored.flatMap((result) => result.findings)];
  const count = (severity) => all.filter((item) => item.severity === severity).length;
  const heaviest = scored.reduce(
    (best, result) => (best === null || result.tokens > best.tokens ? result : best),
    null
  );

  return {
    tools: scored,
    global,
    similar,
    summary: {
      tools: scored.length,
      errors: count('error'),
      warns: count('warn'),
      infos: count('info'),
      score: scored.length
        ? Math.round(scored.reduce((sum, result) => sum + result.score, 0) / scored.length)
        : 0,
      totalTokens,
      avgTokens: scored.length ? Math.round(totalTokens / scored.length) : 0,
      heaviest: heaviest?.name ?? null
    }
  };
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(type, value) {
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeOf(value) === type;
}

function checkValue(spec, value) {
  if (!spec || typeof spec !== 'object') return null;
  if (Array.isArray(spec.enum)) {
    const found = spec.enum.some((option) => JSON.stringify(option) === JSON.stringify(value));
    if (!found) return `must be one of ${JSON.stringify(spec.enum)}`;
  }
  if (spec.const !== undefined && JSON.stringify(spec.const) !== JSON.stringify(value)) {
    return `must equal ${JSON.stringify(spec.const)}`;
  }
  if (spec.type) {
    const types = Array.isArray(spec.type) ? spec.type : [spec.type];
    if (!types.some((type) => matchesType(type, value))) {
      return `expected ${types.join(' or ')}, got ${typeOf(value)}`;
    }
  }
  return null;
}

export function validateArgs(schema, args) {
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    errors.push('arguments must be an object');
    return errors;
  }
  const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];

  for (const key of required) {
    if (!(key in args) || args[key] === undefined) errors.push(`missing required "${key}"`);
  }
  for (const [key, value] of Object.entries(args)) {
    const spec = properties[key];
    if (spec === undefined) {
      if (schema.additionalProperties === false) errors.push(`unknown property "${key}"`);
      continue;
    }
    const problem = checkValue(spec, value);
    if (problem) errors.push(`"${key}": ${problem}`);
  }
  return errors;
}
