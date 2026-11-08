export function normalizeBaseUrl(value) {
  let base = String(value ?? process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434').trim();
  if (!/^https?:\/\//i.test(base)) base = `http://${base}`;
  return base.replace(/\/+$/, '');
}

export async function listModels(baseUrl, { timeoutMs = 5000 } = {}) {
  let response;
  try {
    response = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch {
    throw new Error(
      `cannot reach ollama at ${baseUrl}. install it from https://ollama.com, make sure it is running, then pull a model such as: ollama pull llama3.2:3b`
    );
  }
  if (!response.ok) {
    throw new Error(`ollama at ${baseUrl} returned status ${response.status}`);
  }
  const data = await response.json();
  return (data.models ?? []).map((model) => model.name);
}

function normalizeSchema(schema) {
  const copy = schema && typeof schema === 'object' && !Array.isArray(schema) ? { ...schema } : {};
  delete copy.$schema;
  if (copy.type === undefined) copy.type = 'object';
  if (copy.properties === undefined) copy.properties = {};
  return copy;
}

function toOllamaTool(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: normalizeSchema(tool.inputSchema)
    }
  };
}

function parseArguments(value) {
  if (value === undefined || value === null) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value;
}

export async function chatWithTools({
  baseUrl,
  model,
  prompt,
  system,
  tools,
  temperature = 0,
  timeoutMs = 180000
}) {
  const started = Date.now();
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  let response;
  try {
    response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages,
        tools: tools.map(toOllamaTool),
        options: { temperature }
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    throw new Error(`request to ollama failed: ${error.message}`);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`ollama returned ${response.status}: ${text.slice(0, 300)}`);
  }

  const data = await response.json();
  const toolCalls = (data.message?.tool_calls ?? []).map((call) => ({
    name: call.function?.name ?? '',
    arguments: parseArguments(call.function?.arguments)
  }));

  return {
    toolCalls,
    content: data.message?.content ?? '',
    ms: Date.now() - started
  };
}
