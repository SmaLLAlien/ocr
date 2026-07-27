// Built-in provider presets. Port of internal/llm/providers.go — keep 1:1.

/** Preset configuration for a known LLM provider. */
export interface Provider {
  name: string;
  displayName: string;
  /** "anthropic" or "openai" */
  protocol: 'anthropic' | 'openai';
  baseUrl: string;
  /** Anthropic-only; empty for OpenAI-compatible. */
  authHeader?: string;
  /** Environment variable name for API key fallback. */
  envVar: string;
  models: string[];
}

const registry: Provider[] = [
  {
    name: 'anthropic',
    displayName: 'Anthropic Claude API',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    authHeader: 'x-api-key',
    envVar: 'ANTHROPIC_API_KEY',
    models: ['claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6'],
  },
  {
    name: 'openai',
    displayName: 'OpenAI API',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    envVar: 'OPENAI_API_KEY',
    models: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'],
  },
  {
    name: 'edenai',
    displayName: 'Eden AI',
    protocol: 'openai',
    baseUrl: 'https://api.edenai.run/v3',
    envVar: 'EDENAI_API_KEY',
    models: [
      'anthropic/claude-opus-4-5',
      'anthropic/claude-sonnet-4-5',
      'anthropic/claude-haiku-4-5',
      'openai/gpt-5.1',
      'openai/gpt-5.1-codex',
      'google/gemini-3.1-pro-preview',
      'mistral/devstral-medium-latest',
      'mistral/codestral-latest',
      'deepseek/deepseek-v4-pro',
      'xai/grok-4',
    ],
  },
  {
    // TS-port extension (not in the Go registry): Google Gemini through its
    // OpenAI-compatible endpoint; Bearer-auth with a Google AI Studio key.
    name: 'gemini',
    displayName: 'Google Gemini API',
    protocol: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    envVar: 'GEMINI_API_KEY',
    models: [
      'gemini-3.1-pro-preview',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.0-flash',
    ],
  },
  {
    name: 'dashscope',
    displayName: 'DashScope API',
    protocol: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    envVar: 'DASHSCOPE_API_KEY',
    models: [
      'qwen3.7-max',
      'qwen3.7-plus',
      'qwen3.6-plus',
      'qwen3.6-flash',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'kimi-k2.7-code',
      'glm-5.2',
      'MiniMax-M2.5',
    ],
  },
  {
    name: 'dashscope-tokenplan',
    displayName: 'DashScope Token Plan API',
    protocol: 'openai',
    baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    envVar: 'DASHSCOPE_TOKENPLAN_KEY',
    models: [
      'qwen3.7-max',
      'qwen3.7-plus',
      'qwen3.6-plus',
      'qwen3.6-flash',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'kimi-k2.7-code',
      'kimi-k2.6',
      'kimi-k2.5',
      'glm-5.2',
      'glm-5.1',
      'glm-5',
      'MiniMax-M2.5',
    ],
  },
  {
    name: 'volcengine',
    displayName: 'Volcano Engine Ark API',
    protocol: 'openai',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    envVar: 'ARK_API_KEY',
    models: [
      'doubao-seed-evolving',
      'doubao-seed-2-1-pro-260628',
      'doubao-seed-2-1-turbo-260628',
      'doubao-seed-2-0-lite-260428',
      'doubao-seed-2-0-mini-260428',
      'doubao-seed-2-0-pro-260215',
    ],
  },
  {
    name: 'deepseek',
    displayName: 'DeepSeek API',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com',
    envVar: 'DEEPSEEK_API_KEY',
    models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  },
  {
    name: 'tencent-tokenhub',
    displayName: 'Tencent TokenHub API',
    protocol: 'openai',
    baseUrl: 'https://tokenhub.tencentmaas.com/v1',
    envVar: 'TENCENT_TOKENHUB_API_KEY',
    models: [
      'hy3-preview',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'glm-5.2',
      'glm-5.1',
      'glm-5',
      'glm-5-turbo',
      'kimi-k2.7-code',
      'kimi-k2.6',
      'kimi-k2.5',
      'minimax-m3',
      'minimax-m2.7',
      'minimax-m2.5',
    ],
  },
  {
    name: 'hy-tokenplan',
    displayName: 'Tencent Hunyuan Token Plan API',
    protocol: 'openai',
    baseUrl: 'https://api.lkeap.cloud.tencent.com/plan/v3',
    envVar: 'TENCENT_HUNYUAN_TOKENPLAN_KEY',
    models: ['hy3-preview'],
  },
  {
    name: 'kimi',
    displayName: 'Kimi Moonshot API',
    protocol: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    envVar: 'MOONSHOT_API_KEY',
    models: ['kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6', 'kimi-k2.5'],
  },
  {
    name: 'z-ai',
    displayName: 'Z.AI API',
    protocol: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    envVar: 'Z_AI_API_KEY',
    models: ['glm-5.2', 'glm-5.1', 'glm-5', 'glm-5-turbo', 'glm-4.7'],
  },
  {
    name: 'z-ai-coding',
    displayName: 'Z.AI Coding Plan API',
    protocol: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    envVar: 'Z_AI_CODING_API_KEY',
    models: ['glm-5.2', 'glm-5.1', 'glm-5-turbo', 'glm-4.7'],
  },
  {
    name: 'mimo',
    displayName: 'Xiaomi MiMo API',
    protocol: 'openai',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    envVar: 'MIMO_API_KEY',
    models: ['mimo-v2.5-pro', 'mimo-v2.5'],
  },
  {
    name: 'minimax',
    displayName: 'MiniMax API',
    protocol: 'openai',
    baseUrl: 'https://api.minimaxi.com/v1',
    envVar: 'MINIMAX_API_KEY',
    models: [
      'MiniMax-M3',
      'MiniMax-M2.7',
      'MiniMax-M2.7-highspeed',
      'MiniMax-M2.5',
      'MiniMax-M2.5-highspeed',
    ],
  },
  {
    name: 'baidu-qianfan',
    displayName: 'Baidu Qianfan API',
    protocol: 'openai',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    envVar: 'QIANFAN_API_KEY',
    models: [
      'ernie-5.1',
      'ernie-5.0',
      'ernie-x1.1',
      'ernie-x1-turbo-32k-preview',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'glm-5.2',
      'glm-5.1',
      'glm-5',
      'kimi-k2.6',
    ],
  },
];

const registryMap = new Map<string, Provider>(registry.map((p) => [p.name.toLowerCase(), p]));

/** Returns the preset provider by name (case-insensitive), with a copied models list. */
export function lookupProvider(name: string): Provider | undefined {
  const p = registryMap.get(name.trim().toLowerCase());
  return p ? { ...p, models: [...p.models] } : undefined;
}

/** Returns all built-in providers sorted by name; models lists are copies. */
export function listProviders(): Provider[] {
  return registry
    .map((p) => ({ ...p, models: [...p.models] }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
