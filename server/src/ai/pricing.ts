/** Model pricing table (design §8.6). Prices are USD per 1M tokens and may change. */
export interface ModelPrice {
  inputOffPeak: number;
  inputPeak: number;
  outputOffPeak: number;
  outputPeak: number;
}

export const MODEL_PRICING: Record<string, ModelPrice> = {
  'deepseek-flash': { inputOffPeak: 0.15, inputPeak: 0.3, outputOffPeak: 0.6, outputPeak: 1.2 },
  'deepseek-v4-pro': { inputOffPeak: 0.66, inputPeak: 1.32, outputOffPeak: 1.98, outputPeak: 3.96 },
};

export const DEFAULT_MODEL = 'deepseek-flash';
export const FALLBACK_MODELS = ['deepseek-flash', 'deepseek-v4-pro'];

export function priceForModel(model: string): ModelPrice | null {
  return MODEL_PRICING[model] ?? null;
}

/**
 * Conservative peak-price estimate from explicit token counts. Callers must
 * pass the same tokens they display/charged (preview estimates already include
 * the thinking multiplier; API usage is already actual). Never apply a second
 * thinking multiplier here (review Minor 10).
 */
export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number | undefined {
  const price = priceForModel(model);
  if (!price) return undefined;
  const cost = (inputTokens / 1_000_000) * price.inputPeak + (outputTokens / 1_000_000) * price.outputPeak;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

export function modelLabel(model: string): string {
  return MODEL_PRICING[model] ? model : `${model}（未收录价格）`;
}
