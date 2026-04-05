/** @typedef {'openai' | 'anthropic'} LlmProviderId */

export const DEFAULT_LLM_PROVIDER = "openai";

export const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

export const DEFAULT_ANTHROPIC_MODEL = "claude-3-5-haiku-20241022";

export const LLM_PROVIDERS = [
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic (Claude)" },
];

export const OPENAI_MODEL_IDS = [
  "gpt-4o-mini",
  "gpt-4o",
  "gpt-4-turbo",
  "gpt-4",
  "gpt-3.5-turbo",
  "o1-mini",
  "o1",
];

export const ANTHROPIC_MODEL_IDS = [
  "claude-3-5-haiku-20241022",
  "claude-3-5-sonnet-20241022",
  "claude-3-opus-20240229",
  "claude-3-haiku-20240307",
  "claude-3-sonnet-20240229",
];

/**
 * @param {LlmProviderId} provider
 * @returns {string[]}
 */
export function modelsForProvider(provider) {
  return provider === "anthropic" ? ANTHROPIC_MODEL_IDS : OPENAI_MODEL_IDS;
}

/**
 * @param {LlmProviderId} provider
 * @param {string} currentModel
 * @returns {string}
 */
export function coerceModelForProvider(provider, currentModel) {
  const list = modelsForProvider(provider);
  if (list.includes(currentModel)) return currentModel;
  return provider === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_OPENAI_MODEL;
}
