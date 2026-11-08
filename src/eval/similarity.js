const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'to', 'and', 'or', 'for', 'in', 'on', 'by', 'with',
  'is', 'are', 'be', 'this', 'that', 'it', 'as', 'at', 'from', 'your', 'you',
  'all', 'any', 'can', 'will', 'its', 'into', 'then', 'also', 'which', 'when',
  'if', 'not', 'only', 'use', 'used', 'using'
]);

export function tokenize(text) {
  if (!text) return [];
  const spaced = String(text)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-./]+/g, ' ');
  const words = spaced.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const tokens = [];
  for (const raw of words) {
    if (STOPWORDS.has(raw)) continue;
    let word = raw;
    if (word.length > 2 && word.endsWith('s') && !word.endsWith('ss')) {
      word = word.slice(0, -1);
    }
    if (word.length < 2) continue;
    tokens.push(word);
  }
  return tokens;
}

export function toolText(tool) {
  const name = typeof tool?.name === 'string' ? tool.name : '';
  const description = typeof tool?.description === 'string' ? tool.description : '';
  const properties = tool?.inputSchema?.properties;
  const params =
    properties && typeof properties === 'object' ? Object.keys(properties).join(' ') : '';
  return `${name} ${name} ${description} ${params}`;
}

function termFrequency(tokens) {
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

function weigh(counts, idf) {
  const vector = new Map();
  let sum = 0;
  for (const [term, count] of counts) {
    const weight = (1 + Math.log(count)) * idf(term);
    vector.set(term, weight);
    sum += weight * weight;
  }
  return { vector, norm: Math.sqrt(sum) };
}

function buildIndex(tokenLists) {
  const counts = tokenLists.map(termFrequency);
  const documentFrequency = new Map();
  for (const entry of counts) {
    for (const term of entry.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const total = tokenLists.length;
  const idf = (term) =>
    Math.log((total + 1) / ((documentFrequency.get(term) ?? 0) + 1)) + 1;
  return { idf, docs: counts.map((entry) => weigh(entry, idf)) };
}

export function cosine(a, b) {
  if (a.norm === 0 || b.norm === 0) return 0;
  const [small, large] = a.vector.size <= b.vector.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [term, weight] of small.vector) {
    const other = large.vector.get(term);
    if (other !== undefined) dot += weight * other;
  }
  return dot / (a.norm * b.norm);
}

export function similarTools(tools, threshold = 0.5) {
  const index = buildIndex(tools.map((tool) => tokenize(toolText(tool))));
  const pairs = [];
  for (let i = 0; i < tools.length; i++) {
    for (let j = i + 1; j < tools.length; j++) {
      const score = cosine(index.docs[i], index.docs[j]);
      if (score >= threshold) {
        pairs.push({
          a: tools[i].name,
          b: tools[j].name,
          indexA: i,
          indexB: j,
          score
        });
      }
    }
  }
  return pairs.sort((x, y) => y.score - x.score);
}

export function createRanker(tools) {
  const index = buildIndex(tools.map((tool) => tokenize(toolText(tool))));
  return {
    rank(query) {
      const q = weigh(termFrequency(tokenize(query)), index.idf);
      return tools
        .map((tool, i) => ({ name: tool.name, score: cosine(q, index.docs[i]) }))
        .sort((x, y) => y.score - x.score);
    }
  };
}
