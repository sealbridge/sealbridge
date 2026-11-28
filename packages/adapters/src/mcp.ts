// SPDX-License-Identifier: Apache-2.0
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { sanitizedEnvironment } from '@acp/sandbox';
import type {
  AgentAdapter,
  AgentTaskContext,
  MCPProxy,
  ToolDefinition,
  ToolBackend,
} from '@acp/runtime';
import type { Json } from '@acp/core';
import { resolveCommand } from './command.js';
import { requireNonRootLocalExecution } from '@acp/runtime-local';
export interface McpAdapterOptions {
  client?: Client;
  transport?: Transport;
  stdio?: { command: string; args?: string[] };
  tools: Record<string, ToolDefinition>;
  taskTool?: string;
  execute?: (context: AgentTaskContext) => Promise<Json>;
  proxy?: MCPProxy;
}
export class McpClientAdapter implements AgentAdapter {
  assertStartup(): void {
    if (this.options.stdio) requireNonRootLocalExecution();
  }
  readonly id = 'mcp';
  readonly name = 'MCP Worker';
  readonly skills = [{ id: 'mcp-task', name: 'Capability guarded MCP task' }];
  readonly tools: Record<string, ToolDefinition>;
  readonly toolBackend: ToolBackend;
  #workspaceDir?: string;
  #client?: Client;
  #connecting?: Promise<Client>;
  #owned = false;
  constructor(readonly options: McpAdapterOptions) {
    this.tools = options.tools;
    this.#client = options.client;
    this.toolBackend = { callTool: async (params) => (await this.connect()).callTool(params) };
  }
  private async connect(): Promise<Client> {
    if (this.#client) return this.#client;
    if (!this.#connecting)
      this.#connecting = (async () => {
        const client = new Client({ name: 'acp-mcp-adapter', version: '0.2.0' });
        const transport =
          this.options.transport ??
          (this.options.stdio
            ? new StdioClientTransport({
                command: await resolveCommand(this.options.stdio.command),
                args: this.options.stdio.args,
                env: {
                  ...sanitizedEnvironment(this.#workspaceDir ?? '/tmp'),
                  PATH: '/usr/local/bin:/usr/bin:/bin',
                } as Record<string, string>,
                stderr: 'ignore',
                cwd: this.#workspaceDir,
              })
            : undefined);
        if (!transport) throw new Error('MCP_TRANSPORT_REQUIRED');
        await client.connect(transport);
        this.#client = client;
        this.#owned = true;
        return client;
      })();
    return this.#connecting;
  }
  async executeTask(context: AgentTaskContext): Promise<Json> {
    context.signal.throwIfAborted();
    this.#workspaceDir = context.workspaceDir;
    context.reportIsolation?.('mcp_proxy');
    const abort = () => {
      void this.close();
    };
    context.signal.addEventListener('abort', abort, { once: true });
    try {
      const guarded = this.options.proxy
        ? {
            ...context,
            callTool: async (tool: string, args: Json) =>
              (await this.options.proxy!.callTool(tool, args as Record<string, unknown>)) as Json,
          }
        : context;
      if (this.options.execute) return await this.options.execute(guarded);
      if (!this.options.taskTool) throw new Error('MCP_TASK_TOOL_REQUIRED');
      return await guarded.callTool(this.options.taskTool, context.input);
    } finally {
      context.signal.removeEventListener('abort', abort);
      if (this.options.stdio) await this.close();
    }
  }
  async close(): Promise<void> {
    if (this.#owned) {
      await this.#client?.close();
      this.#client = undefined;
      this.#connecting = undefined;
      this.#owned = false;
    }
  }
}
