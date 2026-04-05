/**
 * @returns {string | null} Raw Anthropic API key from env, or null.
 */
export function resolveAnthropicApiKey() {
  const raw = process.env.ANTHROPIC_API_KEY?.trim();
  return raw || null;
}
