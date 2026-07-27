// User-level app config (~/.opencodereview/config.json).
// Port of the config data model + load helpers from cmd/opencodereview/config_cmd.go.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripBom } from '../util/text.js';

/** Configuration for a single MCP server (stdio transport). */
export interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: string[];
  tools?: string[];
  setup?: string;
}

export interface ProviderEntry {
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

export interface LlmConfig {
  url?: string;
  auth_token?: string;
  auth_header?: string;
  model?: string;
  use_anthropic?: boolean; // absent = default true; false = OpenAI protocol
  extra_body?: Record<string, unknown>;
  extra_headers?: Record<string, string>;
}

/**
 * Telemetry settings. Accepted for config-file compatibility with the Go
 * version; the TS port has no OpenTelemetry integration, so they are stored
 * but have no runtime effect.
 */
export interface TelemetryConfig {
  enabled?: boolean;
  exporter?: string;
  otlp_endpoint?: string;
  content_logging?: boolean;
}

/** The user-level configuration file (~/.opencodereview/config.json). */
export interface AppConfig {
  provider?: string;
  model?: string;
  providers?: Record<string, ProviderEntry>;
  custom_providers?: Record<string, ProviderEntry>;
  llm?: LlmConfig;
  language?: string;
  telemetry?: TelemetryConfig;
  mcp_servers?: Record<string, MCPServerConfig>;
}

/** Default config file location: ~/.opencodereview/config.json */
export function defaultConfigPath(): string {
  return path.join(os.homedir(), '.opencodereview', 'config.json');
}

/**
 * Returns OCR_CONFIG_PATH when set, otherwise the default user config path.
 * Intentionally used only by read-only commands (e.g. ocr llm test). Write
 * paths keep defaultConfigPath() so a leaked OCR_CONFIG_PATH cannot redirect
 * writes.
 */
export function resolveConfigPath(): string {
  const p = (process.env['OCR_CONFIG_PATH'] ?? '').trim();
  if (p !== '') return p;
  return defaultConfigPath();
}

/** Loads config from path. Returns undefined if the file does not exist. */
export function loadAppConfig(configPath: string): AppConfig | undefined {
  let data: string;
  try {
    data = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`read app config ${configPath}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(stripBom(data)) as AppConfig;
  } catch (err) {
    throw new Error(`parse app config: ${(err as Error).message}`);
  }
}

/** Loads config from path, returning an empty config if it does not exist. */
export function loadOrCreateConfig(configPath: string): AppConfig {
  return loadAppConfig(configPath) ?? {};
}

/** Saves config with owner-only permissions (0600), creating the directory. */
export function saveConfig(configPath: string, cfg: AppConfig): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}
