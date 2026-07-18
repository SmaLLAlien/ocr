// MCP tools → tool registry adaptation. Port of internal/mcp/provider.go
// plus initMCPClients from cmd/opencodereview/review_cmd.go.
import { spawnSync } from 'node:child_process';
import type { ToolDef } from '../llm/types.js';
import type { AppConfig } from '../config/appConfig.js';
import { ToolRegistry, isReserved, type ToolArgs, type ToolProvider } from '../tools/registry.js';
import { McpClient, type McpToolInfo } from './client.js';

/** Adapts a single MCP tool to the ToolProvider interface. */
class McpToolProvider implements ToolProvider {
  constructor(
    private readonly name: string,
    private readonly client: McpClient,
  ) {}

  toolName(): string {
    return this.name;
  }

  async execute(args: ToolArgs): Promise<string> {
    return this.client.callTool(this.name, args);
  }
}

/**
 * Registers tools from the MCP client into the registry. When allowedTools
 * is non-empty, only listed names are registered. Conflicts with built-in or
 * already-registered tools are skipped with a warning.
 */
export function registerAll(reg: ToolRegistry, c: McpClient, allowedTools: string[]): void {
  const allowed = new Set(allowedTools);
  const filtering = allowed.size > 0;

  const matched = new Set<string>();
  for (const t of c.tools()) {
    if (filtering) {
      if (!allowed.has(t.name)) continue;
      matched.add(t.name);
    }
    if (isReserved(t.name)) {
      process.stderr.write(
        `[ocr] WARNING: MCP server ${JSON.stringify(c.name())} tool ${JSON.stringify(t.name)} conflicts with built-in tool, skipping\n`,
      );
      continue;
    }
    if (reg.get(t.name)) {
      process.stderr.write(
        `[ocr] WARNING: MCP server ${JSON.stringify(c.name())} tool ${JSON.stringify(t.name)} conflicts with already-registered tool, skipping\n`,
      );
      continue;
    }
    reg.register(new McpToolProvider(t.name, c));
  }

  for (const name of allowed) {
    if (!matched.has(name)) {
      process.stderr.write(
        `[ocr] WARNING: MCP server ${JSON.stringify(c.name())} allowed tool ${JSON.stringify(name)} not found in server's tool list\n`,
      );
    }
  }
}

/** Converts an MCP tool definition to a ToolDef. */
export function toToolDef(t: McpToolInfo): ToolDef {
  const params: Record<string, unknown> = { type: 'object' };
  if (t.inputSchema) {
    Object.assign(params, t.inputSchema);
    if (!('type' in params)) params['type'] = 'object';
  }
  return {
    type: 'function',
    function: { name: t.name, description: t.description ?? '', parameters: params },
  };
}

/**
 * Gathers tool definitions from MCP clients, filtering out tools that
 * conflict with built-ins or were not successfully registered.
 */
export function collectToolDefs(clients: McpClient[], reg: ToolRegistry): ToolDef[] {
  const defs: ToolDef[] = [];
  const seen = new Set<string>();
  for (const c of clients) {
    for (const t of c.tools()) {
      if (isReserved(t.name)) continue;
      if (!reg.get(t.name)) continue;
      if (seen.has(t.name)) continue;
      seen.add(t.name);
      defs.push(toToolDef(t));
    }
  }
  return defs;
}

const SETUP_TIMEOUT_MS = 5 * 60 * 1000;
const INIT_TIMEOUT_MS = 30 * 1000;

/**
 * Starts all configured MCP servers (deterministic name order), running
 * optional setup shell commands first. Failures are non-fatal — the review
 * proceeds without the failing server.
 */
export async function initMCPClients(
  cfg: AppConfig | undefined,
  tools: ToolRegistry,
  repoDir: string,
  version: string,
): Promise<McpClient[]> {
  if (!cfg?.mcp_servers || Object.keys(cfg.mcp_servers).length === 0) return [];

  const names = Object.keys(cfg.mcp_servers).sort();
  const clients: McpClient[] = [];
  for (const name of names) {
    const serverCfg = cfg.mcp_servers[name]!;
    if (!serverCfg.command) {
      process.stderr.write(`[ocr] WARNING: MCP server ${JSON.stringify(name)} has no command configured, skipping\n`);
      continue;
    }
    if (serverCfg.setup) {
      process.stderr.write(`[ocr] Running setup for MCP server ${JSON.stringify(name)}: ${serverCfg.setup}\n`);
      const shell = process.platform === 'win32' ? ['cmd', '/c'] : ['sh', '-c'];
      const res = spawnSync(shell[0]!, [shell[1]!, serverCfg.setup], {
        cwd: repoDir,
        timeout: SETUP_TIMEOUT_MS,
        encoding: 'utf8',
        windowsHide: true,
      });
      if (res.error || res.status !== 0) {
        process.stderr.write(`[ocr] ERROR: MCP server ${JSON.stringify(name)} setup command failed.\n`);
        process.stderr.write(`[ocr]   Command: ${serverCfg.setup}\n`);
        process.stderr.write(`[ocr]   Working directory: ${repoDir}\n`);
        process.stderr.write(`[ocr]   Error: ${res.error?.message ?? `exit code ${res.status}`}\n`);
        const output = (res.stdout ?? '') + (res.stderr ?? '');
        if (output !== '') process.stderr.write(`[ocr]   Output:\n${output}\n`);
        process.stderr.write(`[ocr]   Skipping MCP server ${JSON.stringify(name)} — review will proceed without it.\n`);
        continue;
      }
    }

    try {
      const mc = await McpClient.connect(
        name,
        serverCfg.command,
        serverCfg.args ?? [],
        serverCfg.env ?? [],
        repoDir,
        version,
        INIT_TIMEOUT_MS,
      );
      clients.push(mc);
      registerAll(tools, mc, serverCfg.tools ?? []);
    } catch (err) {
      process.stderr.write(
        `[ocr] WARNING: failed to start MCP server ${JSON.stringify(name)}: ${(err as Error).message}\n`,
      );
    }
  }
  return clients;
}
