// Model catalog shared by main + renderer.
// Claude IDs/pricing are authoritative; OpenAI & Google entries reflect public
// information as of mid-2026 and should be verified against each provider's
// current model list when you wire real keys.

export type Provider = 'anthropic' | 'openai' | 'google';

export interface ModelInfo {
  id: string;
  name: string;
  short: string;
  provider: Provider;
  desc: string;
  ctx: string;
  price: string; // "$in / $out" per Mtok
  badge?: string;
}

export const MODELS: ModelInfo[] = [
  // Anthropic
  { id: 'claude-opus-5', name: 'Claude Opus 5', short: 'Opus 5', provider: 'anthropic', desc: 'Most capable all-rounder — deep reasoning, agentic and long-horizon coding.', ctx: '1M context', price: '$5 / $25', badge: 'Recommended' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', short: 'Sonnet 5', provider: 'anthropic', desc: 'Balanced — near-Opus quality, faster and lower cost.', ctx: '1M context', price: '$3 / $15' },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', short: 'Haiku 4.5', provider: 'anthropic', desc: 'Fastest Claude — quick, cost-effective everyday responses.', ctx: '200K context', price: '$1 / $5' },
  { id: 'claude-fable-5', name: 'Claude Fable 5', short: 'Fable 5', provider: 'anthropic', desc: 'Frontier — the most demanding reasoning and long-horizon agentic work.', ctx: '1M context', price: '$10 / $50' },
  // OpenAI
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', short: 'GPT-5.6 Sol', provider: 'openai', desc: 'OpenAI frontier — complex reasoning and coding.', ctx: '1.05M context', price: '$5 / $30' },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', short: 'GPT-5.6 Terra', provider: 'openai', desc: 'Balanced intelligence and cost for production workloads.', ctx: '1.05M context', price: '$2.50 / $15' },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', short: 'GPT-5.6 Luna', provider: 'openai', desc: 'Cost-sensitive, high-volume workloads.', ctx: '1.05M context', price: '$1 / $6' },
  // Google
  { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', short: 'Gemini 3.1 Pro', provider: 'google', desc: 'Google flagship — industry-leading 2M-token context.', ctx: '2M context', price: '$2 / $12' },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', short: 'Gemini 3.5 Flash', provider: 'google', desc: 'Fast and capable for everyday tasks.', ctx: '1M context', price: '$1.50 / $9' },
  { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash-Lite', short: 'Gemini Flash-Lite', provider: 'google', desc: 'Cheapest current-gen — high-throughput, low latency.', ctx: '1M context', price: '$0.25 / $1.50' },
];

export const DEFAULT_MODEL = 'claude-opus-5';

export const modelById = (id: string): ModelInfo =>
  MODELS.find((m) => m.id === id) || MODELS.find((m) => m.id === DEFAULT_MODEL)!;

export const providerOf = (id: string): Provider => modelById(id).provider;
