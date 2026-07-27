// Endpoint resolution. Line-by-line port of internal/llm/resolver.go —
// the strategy precedence, env var names, and error messages are a contract.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lookupProvider } from './providers.js';
import { stripBom } from '../util/text.js';

/** Resolved LLM endpoint configuration. */
export interface ResolvedEndpoint {
  url: string;
  token: string;
  model: string;
  protocol: 'anthropic' | 'openai';
  /** Anthropic auth header: "x-api-key" or "authorization"; empty for OpenAI. */
  authHeader: string;
  /** Human-readable config source label. */
  source: string;
  extraBody?: Record<string, unknown>;
  extraHeaders?: Record<string, string>;
  /**
   * Per-request HTTP timeout in ms; 0 means use the client default (5 min).
   * Only config file (llm/provider sections) and OCR_LLM_TIMEOUT can set this.
   */
  timeoutMs: number;
}

// Environment variable names for OCR-specific configuration.
const ENV_OCR_LLM_URL = 'OCR_LLM_URL';
const ENV_OCR_LLM_TOKEN = 'OCR_LLM_TOKEN';
const ENV_OCR_LLM_MODEL = 'OCR_LLM_MODEL';
const ENV_OCR_LLM_AUTH_HEADER = 'OCR_LLM_AUTH_HEADER';
const ENV_OCR_LLM_EXTRA_HEADERS = 'OCR_LLM_EXTRA_HEADERS';
// Global override applied after any strategy resolves (all resolution paths).
const ENV_OCR_LLM_TIMEOUT = 'OCR_LLM_TIMEOUT';
const ENV_OCR_USE_ANTHROPIC = 'OCR_USE_ANTHROPIC';

// Environment variable names from Claude Code configuration.
const ENV_CC_BASE_URL = 'ANTHROPIC_BASE_URL';
const ENV_CC_TOKEN = 'ANTHROPIC_AUTH_TOKEN';
const ENV_CC_MODEL = 'ANTHROPIC_MODEL';

function env(name: string): string {
  return process.env[name] ?? '';
}

type StrategyResult = { ep?: ResolvedEndpoint; ok: boolean };

/**
 * Reads from 4 strategy sources in priority order. Each strategy requires all
 * three fields (url, token, model) to be non-empty; the first valid wins.
 */
export function resolveEndpoint(configPath: string): ResolvedEndpoint {
  return resolveEndpointWithModelOverride(configPath, '');
}

export function resolveEndpointWithModelOverride(
  configPath: string,
  modelOverride: string,
): ResolvedEndpoint {
  modelOverride = modelOverride.trim();

  const strategies: Array<{ name: string; fn: () => StrategyResult }> = [
    { name: 'OCR config file', fn: () => tryOCRConfig(configPath, modelOverride) },
    { name: 'OCR environment', fn: () => tryOCREnv(modelOverride) },
    { name: 'Claude Code environment', fn: () => tryCCEnv(modelOverride) },
    { name: 'Shell rc file', fn: () => tryShellRC(modelOverride) },
  ];

  for (const s of strategies) {
    let res: StrategyResult;
    try {
      res = s.fn();
    } catch (err) {
      throw new Error(`resolve ${s.name}: ${errMsg(err)}`);
    }
    const ep = res.ep;
    if (res.ok && ep && ep.url !== '' && ep.token !== '' && ep.model !== '') {
      if (ep.source === '') ep.source = s.name;
      ep.model = stripModelSuffix(ep.model);
      // OCR_LLM_TIMEOUT is a global override: applies regardless of which
      // strategy resolved the endpoint, and takes precedence over
      // config-file values when set.
      let envTimeout: number | undefined;
      try {
        envTimeout = parseTimeoutEnv();
      } catch (err) {
        throw new Error(`resolve ${s.name}: ${errMsg(err)}`);
      }
      if (envTimeout !== undefined) ep.timeoutMs = envTimeout;
      // OCR_LLM_EXTRA_HEADERS is a global override: merges into extra
      // headers regardless of strategy. Env values take precedence.
      const raw = env(ENV_OCR_LLM_EXTRA_HEADERS);
      if (raw !== '') {
        let envHeaders: Record<string, string> | undefined;
        try {
          envHeaders = parseExtraHeaders(raw);
        } catch (err) {
          throw new Error(`resolve ${s.name}: ${errMsg(err)}`);
        }
        if (envHeaders) {
          ep.extraHeaders = { ...(ep.extraHeaders ?? {}), ...envHeaders };
        }
      }
      return ep;
    }
  }

  throw new Error(
    'no valid LLM endpoint configured; one of OCR_LLM_URL/OCR_LLM_TOKEN/OCR_LLM_MODEL, ~/.opencodereview/config.json, or ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN/ANTHROPIC_MODEL must be set',
  );
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Reads and validates OCR_LLM_TIMEOUT. Returns the timeout in ms when set,
 * undefined when unset/empty. Throws on invalid values (non-integer,
 * negative) instead of silently falling back.
 */
function parseTimeoutEnv(): number | undefined {
  const raw = env(ENV_OCR_LLM_TIMEOUT).trim();
  if (raw === '') return undefined;
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`OCR_LLM_TIMEOUT must be an integer (seconds): invalid value ${JSON.stringify(raw)}`);
  }
  const sec = Number(raw);
  try {
    return validateTimeoutSec(sec);
  } catch (err) {
    throw new Error(`OCR_LLM_TIMEOUT: ${errMsg(err)}`);
  }
}

/**
 * Converts a config-file timeout (seconds) to ms. Returns 0 for zero input
 * (use default). Rejects negative values.
 */
export function validateTimeoutSec(sec: number): number {
  if (sec === 0) return 0;
  if (sec < 0) throw new Error(`timeout_sec must be non-negative, got ${sec}`);
  if (!Number.isSafeInteger(sec * 1000)) {
    throw new Error(`timeout_sec ${sec} is too large`);
  }
  return sec * 1000;
}

/** Reads OCR-specific environment variables. */
function tryOCREnv(modelOverride: string): StrategyResult {
  const url = env(ENV_OCR_LLM_URL);
  const token = env(ENV_OCR_LLM_TOKEN);
  let model = env(ENV_OCR_LLM_MODEL);
  if (modelOverride !== '') model = modelOverride;
  if (url === '' || token === '' || model === '') return { ok: false };

  let useAnthropic = true; // default true
  const v = env(ENV_OCR_USE_ANTHROPIC);
  if (v !== '') {
    const lower = v.toLowerCase();
    useAnthropic = lower === 'true' || lower === '1' || lower === 'yes';
  }

  const protocol = useAnthropic ? 'anthropic' : 'openai';

  let authHeader = '';
  if (protocol === 'anthropic') {
    try {
      authHeader = normalizeAuthHeader(env(ENV_OCR_LLM_AUTH_HEADER));
    } catch (err) {
      throw new Error(`OCR environment: ${errMsg(err)}`);
    }
    if (authHeader === '') authHeader = defaultAuthHeader(protocol);
  }

  return {
    ok: true,
    ep: { url, token, model, protocol, authHeader, source: 'OCR environment', timeoutMs: 0 },
  };
}

/** The llm section in config.json (legacy block). */
interface LlmFileConfig {
  url?: string;
  auth_token?: string;
  auth_header?: string;
  model?: string;
  use_anthropic?: boolean; // absent = default true
  timeout_sec?: number;
  extra_body?: Record<string, unknown>;
  extra_headers?: Record<string, string>;
}

/** A single provider entry in config.json. */
interface ProviderEntryConfig {
  api_key?: string;
  url?: string;
  protocol?: string;
  model?: string;
  models?: string[];
  auth_header?: string;
  timeout_sec?: number;
  extra_body?: Record<string, unknown>;
  extra_headers?: Record<string, string>;
}

interface ConfigFileShape {
  provider?: string;
  model?: string;
  providers?: Record<string, ProviderEntryConfig>;
  custom_providers?: Record<string, ProviderEntryConfig>;
  llm?: LlmFileConfig;
}

/** Reads the OCR config file. */
function tryOCRConfig(configPath: string, modelOverride: string): StrategyResult {
  let data: string;
  try {
    data = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false };
    throw err;
  }

  let cfg: ConfigFileShape;
  try {
    cfg = JSON.parse(stripBom(data)) as ConfigFileShape;
  } catch (err) {
    throw new Error(`parse config: ${errMsg(err)}`);
  }

  if (cfg.provider) return tryProviderConfig(cfg, modelOverride);
  return tryLegacyLlmConfig(cfg, modelOverride);
}

/** Resolves an endpoint from the provider-based configuration. */
function tryProviderConfig(cfg: ConfigFileShape, modelOverride: string): StrategyResult {
  const providerName = cfg.provider!;
  const preset = lookupProvider(providerName);
  const isPreset = preset !== undefined;

  const entry = isPreset ? cfg.providers?.[providerName] : cfg.custom_providers?.[providerName];
  if (entry === undefined) {
    const section = isPreset ? 'providers' : 'custom_providers';
    throw new Error(
      `provider ${JSON.stringify(providerName)} is set but not configured in ${section} section`,
    );
  }

  let apiKey = entry.api_key ?? '';
  if (apiKey === '' && isPreset && preset.envVar !== '') {
    apiKey = env(preset.envVar);
  }
  if (apiKey === '') {
    throw new Error(
      `provider ${JSON.stringify(providerName)} has no api_key configured and no environment variable fallback found`,
    );
  }

  let url = '';
  let protocol = '';
  let authHeader = '';
  let model = '';

  if (isPreset) {
    url = preset.baseUrl;
    protocol = preset.protocol;
    authHeader = preset.authHeader ?? '';
    if (entry.url) url = entry.url;
    if (entry.protocol) protocol = entry.protocol.toLowerCase();
  } else {
    // Custom provider: url and protocol are required; model can come from cfg.model.
    if (!entry.url || !entry.protocol) {
      throw new Error(
        `custom provider ${JSON.stringify(providerName)} requires url and protocol fields`,
      );
    }
    const p = entry.protocol.toLowerCase();
    if (p !== 'anthropic' && p !== 'openai') {
      throw new Error(
        `custom provider ${JSON.stringify(providerName)} has invalid protocol ${JSON.stringify(entry.protocol)}: must be "anthropic" or "openai"`,
      );
    }
    url = entry.url;
    protocol = p;
  }

  if (cfg.model) model = cfg.model;
  if (entry.model) model = entry.model;

  // Build available model list for validation.
  const availableModels: string[] = [];
  if (isPreset) availableModels.push(...preset.models);
  availableModels.push(...(entry.models ?? []));

  // Apply model override with validation.
  if (modelOverride !== '') {
    if (availableModels.length > 0 && !modelListContains(availableModels, modelOverride)) {
      throw new Error(
        `model ${JSON.stringify(modelOverride)} is not available for provider ${JSON.stringify(providerName)}; available models: ${availableModels.join(', ')}`,
      );
    }
    model = modelOverride;
  }

  if (model === '') {
    throw new Error(
      `provider ${JSON.stringify(providerName)} has no model configured; run 'ocr config model' to select one or pass --model`,
    );
  }

  if (protocol === 'anthropic') {
    let ah = 'authorization';
    if (isPreset && authHeader !== '') ah = authHeader;
    if (entry.auth_header) ah = entry.auth_header;
    try {
      authHeader = normalizeAuthHeader(ah);
    } catch (err) {
      throw new Error(`provider ${JSON.stringify(providerName)}: ${errMsg(err)}`);
    }
    if (authHeader === '') authHeader = defaultAuthHeader(protocol);
  } else {
    authHeader = '';
  }

  let timeoutMs: number;
  try {
    timeoutMs = validateTimeoutSec(entry.timeout_sec ?? 0);
  } catch (err) {
    throw new Error(`provider ${JSON.stringify(providerName)}: ${errMsg(err)}`);
  }

  if (protocol === 'anthropic') {
    url = ensureMessagesSuffix(url);
  }

  return {
    ok: true,
    ep: {
      url,
      token: apiKey,
      model,
      protocol: protocol as 'anthropic' | 'openai',
      authHeader,
      source: `provider:${providerName}`,
      extraBody: entry.extra_body,
      extraHeaders: entry.extra_headers,
      timeoutMs,
    },
  };
}

/** Resolves an endpoint from the legacy llm config block. */
function tryLegacyLlmConfig(cfg: ConfigFileShape, modelOverride: string): StrategyResult {
  const llm = cfg.llm ?? {};
  let model = llm.model ?? '';
  if (modelOverride !== '') model = modelOverride;
  if (!llm.url || !llm.auth_token || model === '') return { ok: false };

  const useAnthropic = llm.use_anthropic ?? true; // default true
  const protocol = useAnthropic ? 'anthropic' : 'openai';

  let authHeader = '';
  if (protocol === 'anthropic') {
    try {
      authHeader = normalizeAuthHeader(llm.auth_header ?? '');
    } catch (err) {
      throw new Error(`OCR config file: ${errMsg(err)}`);
    }
    if (authHeader === '') authHeader = defaultAuthHeader(protocol);
  }

  let timeoutMs: number;
  try {
    timeoutMs = validateTimeoutSec(llm.timeout_sec ?? 0);
  } catch (err) {
    throw new Error(`OCR config file: ${errMsg(err)}`);
  }

  return {
    ok: true,
    ep: {
      url: llm.url,
      token: llm.auth_token,
      model,
      protocol,
      authHeader,
      source: 'OCR config file',
      extraBody: llm.extra_body,
      extraHeaders: llm.extra_headers,
      timeoutMs,
    },
  };
}

/** Reads Claude Code environment variables. */
function tryCCEnv(modelOverride: string): StrategyResult {
  const baseURL = env(ENV_CC_BASE_URL);
  const token = env(ENV_CC_TOKEN);
  let model = env(ENV_CC_MODEL);
  if (modelOverride !== '') model = modelOverride;
  if (baseURL === '' || token === '' || model === '') return { ok: false };

  const url = ensureMessagesSuffix(baseURL);

  // Claude Code environment tokens are OAuth/Bearer-style credentials.
  return {
    ok: true,
    ep: {
      url,
      token,
      model,
      protocol: 'anthropic',
      authHeader: 'authorization',
      source: 'Claude Code environment',
      timeoutMs: 0,
    },
  };
}

/** Parses shell rc files for ANTHROPIC_* exports. */
function tryShellRC(modelOverride: string): StrategyResult {
  for (const f of shellRCFiles()) {
    const res = parseShellRC(f, modelOverride);
    if (res.ok) return res;
  }
  return { ok: false };
}

function shellRCFiles(): string[] {
  let home: string;
  try {
    home = os.homedir();
  } catch {
    return [];
  }
  const candidates = [
    path.join(home, '.zshrc'),
    path.join(home, '.bashrc'),
    path.join(home, '.bash_profile'),
    path.join(home, '.profile'),
  ];
  return candidates.filter((f) => {
    try {
      fs.statSync(f);
      return true;
    } catch {
      return false;
    }
  });
}

const exportRe = /^export\s+(ANTHROPIC_\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(.+))\s*$/;

const modelSuffixRe = /\[\d+m\]$/;

export function stripModelSuffix(model: string): string {
  return model.replace(modelSuffixRe, '');
}

function parseShellRC(rcPath: string, modelOverride: string): StrategyResult {
  let data: string;
  try {
    data = fs.readFileSync(rcPath, 'utf8');
  } catch {
    return { ok: false };
  }

  let baseURL = '';
  let token = '';
  let model = '';
  for (let line of data.split('\n')) {
    line = line.trim();
    const matches = exportRe.exec(line);
    if (!matches) continue;
    const key = matches[1]!;
    let value = matches[2] ?? '';
    if (value === '') value = matches[3] ?? '';
    if (value === '') value = matches[4] ?? '';
    value = value.trim();

    switch (key) {
      case 'ANTHROPIC_BASE_URL':
        baseURL = value;
        break;
      case 'ANTHROPIC_AUTH_TOKEN':
        token = value;
        break;
      case 'ANTHROPIC_MODEL':
        model = value;
        break;
    }
  }
  if (modelOverride !== '') model = modelOverride;

  if (baseURL === '' || token === '' || model === '') return { ok: false };

  const url = ensureMessagesSuffix(baseURL);

  // Claude Code shell rc tokens are OAuth/Bearer-style credentials.
  return {
    ok: true,
    ep: {
      url,
      token,
      model,
      protocol: 'anthropic',
      authHeader: 'authorization',
      source: 'Shell rc file',
      timeoutMs: 0,
    },
  };
}

export function defaultAuthHeader(protocol: string): string {
  // auth_header is Anthropic-only; OpenAI-compatible clients keep API key auth.
  return protocol === 'anthropic' ? 'authorization' : '';
}

/** Reports whether target matches any entry in models (trimmed). */
export function modelListContains(models: string[], target: string): boolean {
  target = target.trim();
  return models.some((m) => m.trim() === target);
}

/**
 * Normalizes an auth header value to a canonical form.
 * Throws for unrecognized values.
 */
export function normalizeAuthHeader(header: string): string {
  header = header.trim();
  if (header === '') return '';
  switch (header.toLowerCase()) {
    case 'x-api-key':
      return 'x-api-key';
    case 'authorization':
    case 'bearer':
      return 'authorization';
    default:
      throw new Error(
        `unsupported auth_header value ${JSON.stringify(header)}; expected "x-api-key" or "authorization"`,
      );
  }
}

// HTTP headers that extra_headers must not override; managed by dedicated
// config fields or set automatically by the SDK.
const reservedHeaders = new Set(['authorization', 'x-api-key', 'content-type', 'user-agent']);

/**
 * Parses comma-separated key=value pairs into a dictionary. Values may be
 * double-quoted to include commas. Reserved header names are rejected.
 */
export function parseExtraHeaders(raw: string): Record<string, string> | undefined {
  if (raw === '') return undefined;

  const pairs = splitHeaderPairs(raw);

  const result: Record<string, string> = {};
  for (let pair of pairs) {
    pair = pair.trim();
    if (pair === '') continue;
    const idx = pair.indexOf('=');
    if (idx < 0) {
      throw new Error(`invalid extra header ${JSON.stringify(pair)}: expected key=value`);
    }
    const key = pair.slice(0, idx).trim();
    let value = pair.slice(idx + 1).trim();
    if (key === '') {
      throw new Error(`invalid extra header ${JSON.stringify(pair)}: empty header name`);
    }
    if (reservedHeaders.has(key.toLowerCase())) {
      throw new Error(
        `extra header ${JSON.stringify(key)} conflicts with a reserved header; use the dedicated config field instead`,
      );
    }
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/** Splits on commas while respecting double-quoted segments. */
function splitHeaderPairs(raw: string): string[] {
  const pairs: string[] = [];
  let sb = '';
  let inQuote = false;
  for (const c of raw) {
    if (c === '"') {
      inQuote = !inQuote;
      sb += c;
    } else if (c === ',' && !inQuote) {
      pairs.push(sb);
      sb = '';
    } else {
      sb += c;
    }
  }
  if (sb.length > 0 || pairs.length === 0) pairs.push(sb);
  if (inQuote) throw new Error('unclosed quote in extra headers');
  return pairs;
}

/** Appends /v1/messages to base URLs that lack a versioned path. */
export function ensureMessagesSuffix(rawURL: string): string {
  const u = rawURL.replace(/\/+$/, '');
  if (u.includes('/v1/')) {
    // Already has versioned path — don't modify.
    return rawURL;
  }
  return u + '/v1/messages';
}
