// ocr config. Port of cmd/opencodereview/config_cmd.go (set/unset paths;
// the interactive provider/model wizards live in setup.ts on @clack/prompts
// instead of the Go bubbletea TUI).
import {
  defaultConfigPath,
  loadOrCreateConfig,
  saveConfig,
  type AppConfig,
  type MCPServerConfig,
  type ProviderEntry,
} from '../config/appConfig.js';
import { lookupProvider } from '../llm/providers.js';
import { modelListContains, normalizeAuthHeader, parseExtraHeaders } from '../llm/resolver.js';
import { runConfigModel, runConfigProvider } from './setup.js';

export async function runConfig(args: string[]): Promise<void> {
  if (args.length === 0) {
    printConfigUsage();
    return;
  }

  switch (args[0]) {
    case 'provider':
      if (args.length !== 1) {
        throw new Error(
          "config provider does not accept arguments; use 'ocr config set provider <name>' for non-interactive setup",
        );
      }
      return runConfigProvider();
    case 'model':
      if (args.length !== 1) {
        throw new Error(
          "config model does not accept arguments; use 'ocr config set model <name>' for non-interactive setup",
        );
      }
      return runConfigModel();
  }

  const action = parseConfigArgs(args);
  switch (action.subCmd) {
    case 'set':
      return runConfigSet(action.key, action.value);
    case 'unset':
      return runConfigUnset(action.key);
    default:
      throw new Error(`unknown config sub-command: ${action.subCmd}`);
  }
}

interface ConfigAction {
  subCmd: string;
  key: string;
  value: string;
}

function parseConfigArgs(args: string[]): ConfigAction {
  const subCmd = args[0]!;
  switch (subCmd) {
    case 'set':
      if (args.length < 3) {
        throw new Error('usage: ocr config set <key> <value>\ne.g., ocr config set llm.model claude-opus-4-6');
      }
      return { subCmd: 'set', key: args[1]!, value: args[2]! };
    case 'unset':
      if (args.length < 2) {
        throw new Error(
          'usage: ocr config unset custom_providers.<name>\ne.g., ocr config unset custom_providers.my-gateway',
        );
      }
      return { subCmd: 'unset', key: args[1]!, value: '' };
    default:
      throw new Error(`unknown config sub-command: ${subCmd}\nAvailable: set, unset, provider, model`);
  }
}

async function runConfigSet(key: string, value: string): Promise<void> {
  const configPath = defaultConfigPath();
  let cfg: AppConfig;
  try {
    cfg = loadOrCreateConfig(configPath);
  } catch (err) {
    throw new Error(`load config: ${(err as Error).message}`);
  }

  setConfigValue(cfg, key, value);
  saveConfig(configPath, cfg);

  let displayValue = value;
  const normalizedKey = key.toLowerCase().replaceAll('_', '');
  if (normalizedKey.endsWith('apikey') || normalizedKey.endsWith('authtoken')) {
    displayValue = maskKey(value);
  }
  console.log(`Set ${key} = ${displayValue}`);
}

async function runConfigUnset(key: string): Promise<void> {
  const parts = key.split('.');
  if (parts.length < 2 || parts.slice(1).join('.') === '') {
    throw new Error('unset supports custom_providers.<name> and mcp_servers.<name>');
  }
  const configPath = defaultConfigPath();
  const name = parts.slice(1).join('.');

  switch (parts[0]) {
    case 'custom_providers':
      return unsetCustomProvider(configPath, name);
    case 'mcp_servers':
      return unsetMCPServer(configPath, name);
    default:
      throw new Error('unset supports custom_providers.<name> and mcp_servers.<name>');
  }
}

function unsetCustomProvider(configPath: string, name: string): void {
  const cfg = loadOrCreateConfig(configPath);

  if (!cfg.custom_providers || !(name in cfg.custom_providers)) {
    throw new Error(`custom provider ${JSON.stringify(name)} not found`);
  }
  const wasActive = cfg.provider === name;
  delete cfg.custom_providers[name];
  if (Object.keys(cfg.custom_providers).length === 0) delete cfg.custom_providers;
  if (wasActive) {
    delete cfg.provider;
    delete cfg.model;
  }

  saveConfig(configPath, cfg);
  console.log(`Deleted custom provider ${JSON.stringify(name)}.`);
  if (wasActive) {
    process.stderr.write("[ocr] WARNING: active provider was deleted; 'provider' and 'model' have been cleared.\n");
    process.stderr.write("[ocr] Run 'ocr config provider' to select a new provider.\n");
  }
}

function unsetMCPServer(configPath: string, name: string): void {
  const cfg = loadOrCreateConfig(configPath);

  if (!cfg.mcp_servers || !(name in cfg.mcp_servers)) {
    throw new Error(`MCP server ${JSON.stringify(name)} not found`);
  }
  delete cfg.mcp_servers[name];
  if (Object.keys(cfg.mcp_servers).length === 0) delete cfg.mcp_servers;

  saveConfig(configPath, cfg);
  console.log(`Deleted MCP server ${JSON.stringify(name)}.`);
}

export function maskKey(key: string): string {
  if (key === '') return '(not set)';
  if (key.length <= 8) return '***';
  return key.slice(0, 4) + '***' + key.slice(-4);
}

const UNKNOWN_KEY_HELP =
  'Supported keys: provider, model, providers.<name>.<field>, custom_providers.<name>.<field>, mcp_servers.<name>.<field>, llm.url, llm.auth_token, llm.auth_header, llm.model, llm.use_anthropic, llm.extra_body, llm.extra_headers, language, telemetry.enabled, telemetry.exporter, telemetry.otlp_endpoint, telemetry.content_logging\nProvider fields: api_key, url, protocol, model, models, auth_header, extra_body, extra_headers\nMCP server fields: command, args, env, tools, setup';

export function setConfigValue(cfg: AppConfig, key: string, value: string): void {
  if (key.startsWith('providers.')) return setProviderValue(cfg, key, value);
  if (key.startsWith('custom_providers.')) return setCustomProviderValue(cfg, key, value);
  if (key.startsWith('mcp_servers.')) return setMCPServerValue(cfg, key, value);

  switch (key) {
    case 'provider': {
      if (cfg.provider !== value) delete cfg.model;
      cfg.provider = value;
      if (lookupProvider(value)) {
        cfg.providers ??= {};
        cfg.providers[value] ??= {};
      } else {
        cfg.custom_providers ??= {};
        cfg.custom_providers[value] ??= {};
      }
      break;
    }
    case 'model': {
      if (cfg.provider) {
        if (lookupProvider(cfg.provider)) {
          cfg.providers ??= {};
          cfg.providers[cfg.provider] = { ...(cfg.providers[cfg.provider] ?? {}), model: value };
        } else {
          cfg.custom_providers ??= {};
          cfg.custom_providers[cfg.provider] = {
            ...(cfg.custom_providers[cfg.provider] ?? {}),
            model: value,
          };
        }
      } else {
        cfg.model = value;
      }
      break;
    }
    case 'llm.url':
    case 'llm.URL':
      cfg.llm = { ...(cfg.llm ?? {}), url: value };
      break;
    case 'llm.auth_token':
    case 'llm.AuthToken':
      cfg.llm = { ...(cfg.llm ?? {}), auth_token: value };
      break;
    case 'llm.auth_header':
    case 'llm.AuthHeader':
      cfg.llm = { ...(cfg.llm ?? {}), auth_header: normalizeAuthHeader(value) };
      break;
    case 'llm.extra_headers':
    case 'llm.ExtraHeaders':
      cfg.llm = { ...(cfg.llm ?? {}), extra_headers: parseExtraHeaders(value) };
      break;
    case 'llm.model':
    case 'llm.Model':
      cfg.llm = { ...(cfg.llm ?? {}), model: value };
      break;
    case 'llm.use_anthropic':
    case 'llm.UseAnthropic':
      cfg.llm = { ...(cfg.llm ?? {}), use_anthropic: parseBoolStrict(value, 'llm.use_anthropic') };
      break;
    case 'language':
    case 'Language':
      cfg.language = value;
      break;
    case 'telemetry.enabled':
    case 'telemetry.Enabled':
      cfg.telemetry = { ...(cfg.telemetry ?? {}), enabled: parseBoolStrict(value, 'telemetry.enabled') };
      break;
    case 'telemetry.exporter':
    case 'telemetry.Exporter':
      cfg.telemetry = { ...(cfg.telemetry ?? {}), exporter: value };
      break;
    case 'telemetry.otlp_endpoint':
    case 'telemetry.OTLPEndpoint':
      cfg.telemetry = { ...(cfg.telemetry ?? {}), otlp_endpoint: value };
      break;
    case 'telemetry.content_logging':
    case 'telemetry.ContentLog':
      cfg.telemetry = {
        ...(cfg.telemetry ?? {}),
        content_logging: parseBoolStrict(value, 'telemetry.content_logging'),
      };
      break;
    case 'llm.extra_body':
    case 'llm.ExtraBody': {
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(value) as Record<string, unknown>;
      } catch (err) {
        throw new Error(`invalid JSON for llm.extra_body: ${(err as Error).message}`);
      }
      cfg.llm = { ...(cfg.llm ?? {}), extra_body: m };
      break;
    }
    default:
      throw new Error(`unknown config key: ${key}\n${UNKNOWN_KEY_HELP}`);
  }
}

function parseBoolStrict(value: string, key: string): boolean {
  switch (value.toLowerCase()) {
    case '1':
    case 't':
    case 'true':
      return true;
    case '0':
    case 'f':
    case 'false':
      return false;
    default:
      throw new Error(`invalid boolean for ${key}: invalid value ${JSON.stringify(value)}`);
  }
}

function applyProviderField(entry: ProviderEntry, field: string, key: string, value: string): void {
  switch (field) {
    case 'api_key':
      entry.api_key = value;
      break;
    case 'url':
      entry.url = value;
      break;
    case 'protocol':
      if (value !== 'anthropic' && value !== 'openai') {
        throw new Error(`invalid protocol ${JSON.stringify(value)}: must be "anthropic" or "openai"`);
      }
      entry.protocol = value;
      break;
    case 'model':
      entry.model = value;
      break;
    case 'models': {
      try {
        entry.models = parseModelListValue(value);
      } catch (err) {
        throw new Error(`invalid model list for ${key}: ${(err as Error).message}`);
      }
      break;
    }
    case 'auth_header':
      entry.auth_header = normalizeAuthHeader(value);
      break;
    case 'extra_body': {
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(value) as Record<string, unknown>;
      } catch (err) {
        throw new Error(`invalid JSON for ${key}: ${(err as Error).message}`);
      }
      entry.extra_body = m;
      break;
    }
    case 'extra_headers': {
      try {
        entry.extra_headers = parseExtraHeaders(value);
      } catch (err) {
        throw new Error(`invalid extra headers for ${key}: ${(err as Error).message}`);
      }
      break;
    }
    default:
      throw new Error(
        `unknown provider field ${JSON.stringify(field)}: supported fields are api_key, url, protocol, model, models, auth_header, extra_body, extra_headers`,
      );
  }
}

export function parseModelListValue(value: string): string[] {
  value = value.trim();
  if (value === '') return [];

  if (value.startsWith('[')) {
    try {
      const models = JSON.parse(value) as unknown;
      if (Array.isArray(models) && models.every((m): m is string => typeof m === 'string')) {
        return normalizeModelList(models);
      }
    } catch {
      // fall through to comma parsing
    }
    value = value.replace(/^\[/, '').replace(/\]$/, '').trim();
  }

  return normalizeModelList(value.split(','));
}

export function normalizeModelList(models: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let model of models) {
    model = model.trim();
    if (model === '' || seen.has(model)) continue;
    seen.add(model);
    out.push(model);
  }
  return out;
}

export function mergeModelLists(...lists: string[][]): string[] {
  return normalizeModelList(lists.flat());
}

/** Appends model when missing; never reorders existing entries. */
export function ensureModelInList(models: string[], model: string): string[] {
  model = model.trim();
  if (model === '') return models;
  if (modelListContains(models, model)) return models;
  return [...models, model];
}

function setProviderValue(cfg: AppConfig, key: string, value: string): void {
  const parts = splitN(key, '.', 3);
  if (parts.length !== 3 || parts[1] === '' || parts[2] === '') {
    throw new Error(`invalid provider key ${JSON.stringify(key)}: expected providers.<name>.<field>`);
  }
  if (!lookupProvider(parts[1]!)) {
    return setCustomProviderField(cfg, parts[1]!, parts[2]!, key, value);
  }
  cfg.providers ??= {};
  const entry = { ...(cfg.providers[parts[1]!] ?? {}) };
  applyProviderField(entry, parts[2]!, key, value);
  cfg.providers[parts[1]!] = entry;
}

function setCustomProviderValue(cfg: AppConfig, key: string, value: string): void {
  const parts = splitN(key, '.', 3);
  if (parts.length !== 3 || parts[1] === '' || parts[2] === '') {
    throw new Error(`invalid custom provider key ${JSON.stringify(key)}: expected custom_providers.<name>.<field>`);
  }
  setCustomProviderField(cfg, parts[1]!, parts[2]!, key, value);
}

function setCustomProviderField(
  cfg: AppConfig,
  name: string,
  field: string,
  key: string,
  value: string,
): void {
  cfg.custom_providers ??= {};
  const entry = { ...(cfg.custom_providers[name] ?? {}) };
  applyProviderField(entry, field, key, value);
  cfg.custom_providers[name] = entry;
}

function setMCPServerValue(cfg: AppConfig, key: string, value: string): void {
  const parts = splitN(key, '.', 3);
  if (parts.length !== 3 || parts[1] === '' || parts[2] === '') {
    throw new Error(`invalid MCP server key ${JSON.stringify(key)}: expected mcp_servers.<name>.<field>`);
  }
  const [, name, field] = parts as [string, string, string];

  cfg.mcp_servers ??= {};
  const entry: MCPServerConfig = { ...(cfg.mcp_servers[name] ?? { command: '' }) };

  switch (field) {
    case 'command':
      if (value === '') throw new Error('MCP server command cannot be empty');
      entry.command = value;
      break;
    case 'args':
      entry.args = parseStringArray(value, key);
      break;
    case 'env': {
      const env = parseStringArray(value, key);
      for (const e of env) {
        const idx = e.indexOf('=');
        if (idx <= 0) throw new Error(`invalid env entry ${JSON.stringify(e)}: must be in KEY=VALUE format`);
      }
      entry.env = env;
      break;
    }
    case 'tools': {
      const tools = parseStringArray(value, key);
      const seen = new Set<string>();
      const filtered: string[] = [];
      for (const t of tools) {
        if (t === '') throw new Error(`tool names in ${key} must not be empty`);
        if (seen.has(t)) continue;
        seen.add(t);
        filtered.push(t);
      }
      entry.tools = filtered;
      break;
    }
    case 'setup':
      entry.setup = value;
      break;
    default:
      throw new Error(
        `unknown MCP server field ${JSON.stringify(field)}: supported fields are command, args, env, tools, setup`,
      );
  }

  cfg.mcp_servers[name] = entry;
}

function parseStringArray(value: string, key: string): string[] {
  let arr: unknown;
  try {
    arr = JSON.parse(value);
  } catch (err) {
    throw new Error(`invalid JSON array for ${key}: ${(err as Error).message}`);
  }
  if (!Array.isArray(arr) || !arr.every((x): x is string => typeof x === 'string')) {
    throw new Error(`invalid JSON array for ${key}: expected an array of strings`);
  }
  return arr;
}

function splitN(s: string, sep: string, n: number): string[] {
  const parts: string[] = [];
  let rest = s;
  while (parts.length < n - 1) {
    const idx = rest.indexOf(sep);
    if (idx < 0) break;
    parts.push(rest.slice(0, idx));
    rest = rest.slice(idx + 1);
  }
  parts.push(rest);
  return parts;
}

export function printConfigUsage(): void {
  console.log(`Configuration management.

Usage:
  ocr config set <key> <value>
  ocr config unset custom_providers.<name>  Delete a custom provider
  ocr config unset mcp_servers.<name>       Delete an MCP server
  ocr config provider                       Interactive provider setup
  ocr config model                          Interactive model selection

Examples:
  # Provider setup (interactive)
  ocr config provider
  ocr config model

  # Provider setup (non-interactive)
  ocr config set provider anthropic
  ocr config set model claude-opus-4-6
  # Set API key via environment variable (recommended) or config:
  # export ANTHROPIC_API_KEY=sk-ant-xxx
  ocr config set providers.anthropic.api_key "$ANTHROPIC_API_KEY"

  # Custom provider
  ocr config set provider my-gateway
  ocr config set custom_providers.my-gateway.url https://gateway.internal.com/v1
  ocr config set custom_providers.my-gateway.protocol openai
  ocr config set custom_providers.my-gateway.model llama-3-70b
  ocr config set custom_providers.my-gateway.models '["llama-3-70b","llama-3-8b"]'
  ocr config set custom_providers.my-gateway.api_key "$MY_API_KEY"

  # Delete a custom provider
  ocr config unset custom_providers.my-gateway

  # MCP server configuration (stdio transport)
  ocr config set mcp_servers.codegraph.command npx
  ocr config set mcp_servers.codegraph.args '["-y","@anthropic/codegraph-mcp"]'
  ocr config set mcp_servers.codegraph.env '["CODEGRAPH_TOKEN=xxx"]'

  # Delete an MCP server
  ocr config unset mcp_servers.codegraph

  # Legacy endpoint configuration
  ocr config set llm.url https://xx/v1/openai/chat/completions
  ocr config set llm.auth_token xxxxxxxxxx
  ocr config set llm.auth_header x-api-key
  ocr config set llm.model claude-opus-4-6
  ocr config set llm.extra_body '{"thinking":{"type":"disabled"}}'
  ocr config set language English
  ocr config set telemetry.enabled true

${UNKNOWN_KEY_HELP.replace('Supported keys:', 'Supported keys:')}`);
}
