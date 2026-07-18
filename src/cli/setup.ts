// Interactive provider/model configuration on @clack/prompts.
// Functional replacement for the Go bubbletea TUI (provider_tui.go /
// provider_cmd.go): pick a preset / define a custom provider / configure a
// manual endpoint, enter the API key, choose a model, save, then run a
// connection test — same flow, simpler UI.
import * as p from '@clack/prompts';
import {
  defaultConfigPath,
  loadOrCreateConfig,
  saveConfig,
  type AppConfig,
} from '../config/appConfig.js';
import { listProviders, lookupProvider } from '../llm/providers.js';
import { runLLMTest } from './llm.js';
import { maskKey, ensureModelInList, mergeModelLists } from './config.js';

function bail(value: unknown): asserts value is string | boolean {
  if (p.isCancel(value)) {
    p.cancel('Cancelled.');
    process.exit(1);
  }
}

export async function runConfigProvider(): Promise<void> {
  p.intro('OpenCodeReview provider setup');

  const kind = await p.select({
    message: 'How do you want to configure the LLM?',
    options: [
      { value: 'official', label: 'Official provider', hint: 'built-in presets (anthropic, openai, ...)' },
      { value: 'custom', label: 'Custom provider', hint: 'your own gateway with a name' },
      { value: 'manual', label: 'Manual endpoint', hint: 'legacy llm.url / llm.auth_token config' },
    ],
  });
  bail(kind);

  const configPath = defaultConfigPath();
  const cfg = loadOrCreateConfig(configPath);

  switch (kind) {
    case 'official':
      await configureOfficial(cfg);
      break;
    case 'custom':
      await configureCustom(cfg);
      break;
    case 'manual':
      await configureManual(cfg);
      break;
  }

  saveConfig(configPath, cfg);
  p.log.success(`Saved ${configPath}`);
  p.outro('Testing connection...');
  await runLLMTest();
}

async function configureOfficial(cfg: AppConfig): Promise<void> {
  const providers = listProviders();
  const name = await p.select({
    message: 'Provider',
    options: providers.map((pr) => ({ value: pr.name, label: pr.displayName, hint: pr.baseUrl })),
  });
  bail(name);
  const preset = lookupProvider(name as string)!;

  cfg.providers ??= {};
  const entry = { ...(cfg.providers[preset.name] ?? {}) };

  const envKey = process.env[preset.envVar] ?? '';
  const currentKey = entry.api_key ?? '';
  const keyHint =
    currentKey !== ''
      ? `current: ${maskKey(currentKey)}; empty keeps it`
      : envKey !== ''
        ? `empty uses $${preset.envVar} (${maskKey(envKey)})`
        : `or set $${preset.envVar}`;
  const apiKey = await p.password({ message: `API key (${keyHint})` });
  if (p.isCancel(apiKey)) {
    p.cancel('Cancelled.');
    process.exit(1);
  }
  if (apiKey) entry.api_key = apiKey;

  const models = mergeModelLists(preset.models, entry.models ?? []);
  const model = await p.select({
    message: 'Model',
    options: models.map((m) => ({ value: m, label: m })),
    initialValue: entry.model && models.includes(entry.model) ? entry.model : models[0],
  });
  bail(model);
  entry.model = model as string;

  if (cfg.provider !== preset.name) delete cfg.model;
  cfg.provider = preset.name;
  cfg.providers[preset.name] = entry;
}

async function configureCustom(cfg: AppConfig): Promise<void> {
  const name = await p.text({
    message: 'Provider name',
    placeholder: 'my-gateway',
    validate: (v) => {
      if (!v || v.trim() === '') return 'name is required';
      if (lookupProvider(v.trim())) return 'name collides with a built-in preset';
      return undefined;
    },
  });
  bail(name);

  const url = await p.text({
    message: 'Base URL',
    placeholder: 'https://gateway.internal.com/v1',
    validate: (v) => (!v || v.trim() === '' ? 'url is required' : undefined),
  });
  bail(url);

  const protocol = await p.select({
    message: 'Protocol',
    options: [
      { value: 'openai', label: 'openai', hint: 'Chat Completions compatible' },
      { value: 'anthropic', label: 'anthropic', hint: 'Messages API compatible' },
    ],
  });
  bail(protocol);

  const apiKey = await p.password({ message: 'API key' });
  if (p.isCancel(apiKey)) {
    p.cancel('Cancelled.');
    process.exit(1);
  }

  const model = await p.text({
    message: 'Model',
    placeholder: 'llama-3-70b',
    validate: (v) => (!v || v.trim() === '' ? 'model is required' : undefined),
  });
  bail(model);

  const trimmedName = (name as string).trim();
  cfg.custom_providers ??= {};
  const entry = { ...(cfg.custom_providers[trimmedName] ?? {}) };
  entry.url = (url as string).trim();
  entry.protocol = protocol as string;
  if (apiKey) entry.api_key = apiKey;
  entry.model = (model as string).trim();
  entry.models = ensureModelInList(entry.models ?? [], entry.model);
  cfg.custom_providers[trimmedName] = entry;

  if (cfg.provider !== trimmedName) delete cfg.model;
  cfg.provider = trimmedName;
}

async function configureManual(cfg: AppConfig): Promise<void> {
  const url = await p.text({
    message: 'Endpoint URL',
    placeholder: 'https://api.example.com/v1/messages',
    initialValue: cfg.llm?.url ?? '',
    validate: (v) => (!v || v.trim() === '' ? 'url is required' : undefined),
  });
  bail(url);

  const token = await p.password({
    message: `Auth token${cfg.llm?.auth_token ? ` (current: ${maskKey(cfg.llm.auth_token)}; empty keeps it)` : ''}`,
  });
  if (p.isCancel(token)) {
    p.cancel('Cancelled.');
    process.exit(1);
  }

  const model = await p.text({
    message: 'Model',
    initialValue: cfg.llm?.model ?? '',
    validate: (v) => (!v || v.trim() === '' ? 'model is required' : undefined),
  });
  bail(model);

  const useAnthropic = await p.select({
    message: 'Protocol',
    options: [
      { value: 'true', label: 'anthropic', hint: 'Messages API' },
      { value: 'false', label: 'openai', hint: 'Chat Completions' },
    ],
    initialValue: cfg.llm?.use_anthropic === false ? 'false' : 'true',
  });
  bail(useAnthropic);

  cfg.llm = { ...(cfg.llm ?? {}) };
  cfg.llm.url = (url as string).trim();
  if (token) cfg.llm.auth_token = token;
  cfg.llm.model = (model as string).trim();
  cfg.llm.use_anthropic = useAnthropic === 'true';
  // Manual endpoint takes over: clear provider-based selection.
  delete cfg.provider;
  delete cfg.model;
}

export async function runConfigModel(): Promise<void> {
  const configPath = defaultConfigPath();
  const cfg = loadOrCreateConfig(configPath);

  if (!cfg.provider) {
    throw new Error("no provider configured; run 'ocr config provider' first");
  }

  const preset = lookupProvider(cfg.provider);
  const entry = preset ? cfg.providers?.[cfg.provider] : cfg.custom_providers?.[cfg.provider];
  const models = mergeModelLists(preset?.models ?? [], entry?.models ?? []);
  if (models.length === 0) {
    throw new Error(
      `provider ${JSON.stringify(cfg.provider)} has no known models; set one with 'ocr config set model <name>'`,
    );
  }

  p.intro(`Model selection for provider "${cfg.provider}"`);
  const model = await p.select({
    message: 'Model',
    options: models.map((m) => ({ value: m, label: m })),
    initialValue: entry?.model && models.includes(entry.model) ? entry.model : models[0],
  });
  bail(model);

  if (preset) {
    cfg.providers ??= {};
    cfg.providers[cfg.provider] = { ...(cfg.providers[cfg.provider] ?? {}), model: model as string };
  } else {
    cfg.custom_providers ??= {};
    cfg.custom_providers[cfg.provider] = {
      ...(cfg.custom_providers[cfg.provider] ?? {}),
      model: model as string,
    };
  }

  saveConfig(configPath, cfg);
  p.outro(`Set model = ${model as string}`);
}
