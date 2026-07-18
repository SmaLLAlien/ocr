// MCP server connection (stdio transport). Port of internal/mcp/client.go
// on the official @modelcontextprotocol/sdk.
import { Client as McpSdkClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Wraps a single MCP server connection via stdio transport. */
export class McpClient {
  private constructor(
    private readonly serverName: string,
    private readonly sdk: McpSdkClient,
    private readonly toolList: McpToolInfo[],
  ) {}

  /**
   * Starts an MCP server subprocess, initializes the connection, and caches
   * the tool list. timeoutMs bounds Connect + ListTools only — the
   * subprocess stays alive until close().
   */
  static async connect(
    name: string,
    command: string,
    args: string[],
    env: string[],
    dir: string,
    version: string,
    timeoutMs: number,
  ): Promise<McpClient> {
    const envMap: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) envMap[k] = v;
    }
    for (const e of env) {
      const idx = e.indexOf('=');
      if (idx > 0) envMap[e.slice(0, idx)] = e.slice(idx + 1);
    }

    const transport = new StdioClientTransport({
      command,
      args,
      env: envMap,
      cwd: dir !== '' ? dir : undefined,
      stderr: 'ignore',
    });

    const sdk = new McpSdkClient({ name: 'open-code-review', version });

    const deadline = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('MCP init timed out')), timeoutMs).unref();
    });

    try {
      await Promise.race([sdk.connect(transport), deadline]);
      const result = (await Promise.race([sdk.listTools(), deadline])) as {
        tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
      };
      const tools: McpToolInfo[] = result.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema:
          typeof t.inputSchema === 'object' && t.inputSchema !== null
            ? (t.inputSchema as Record<string, unknown>)
            : undefined,
      }));
      return new McpClient(name, sdk, tools);
    } catch (err) {
      await sdk.close().catch(() => undefined);
      throw new Error(
        `connect to MCP server ${JSON.stringify(name)}: ${(err as Error).message}`,
      );
    }
  }

  name(): string {
    return this.serverName;
  }

  tools(): McpToolInfo[] {
    return this.toolList;
  }

  /** Invokes a tool on the MCP server and returns the text result. */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    let result;
    try {
      result = await this.sdk.callTool({ name, arguments: args });
    } catch (err) {
      throw new Error(`call MCP tool ${JSON.stringify(name)}: ${(err as Error).message}`);
    }

    const text = contentToText(result['content']);
    if (result['isError']) {
      return `MCP tool ${JSON.stringify(name)} returned an error: ${text}`;
    }
    return text;
  }

  async close(): Promise<void> {
    await this.sdk.close();
  }
}

function contentToText(contents: unknown): string {
  if (!Array.isArray(contents)) return '';
  const parts: string[] = [];
  for (const item of contents) {
    if (typeof item === 'object' && item !== null && (item as { type?: string }).type === 'text') {
      parts.push(String((item as { text?: unknown }).text ?? ''));
    } else {
      parts.push(`[unsupported content type: ${String((item as { type?: string })?.type)}]`);
    }
  }
  return parts.join('\n');
}
