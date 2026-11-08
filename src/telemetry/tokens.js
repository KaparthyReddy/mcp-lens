export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function estimateValueTokens(value) {
  if (value === undefined || value === null) return 0;
  return estimateTokens(typeof value === 'string' ? value : JSON.stringify(value));
}
