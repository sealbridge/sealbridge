// SPDX-License-Identifier: Apache-2.0
import { checkInputSize, checkModelInputBudget, modelInputMessage } from '@acp/core';
import type { Json, TaskManifest } from '@acp/core';
import type { AgentAdapter, AgentTaskContext } from '@acp/runtime';
import { parseJsonDeliverable } from './command.js';
export interface OpenAICompatibleOptions {
  baseUrl?: string;
  endpoint?: string;
  model: string;
  apiKey?: string;
  apiKeyEnv?: string;
  fetch?: typeof fetch;
  apiStyle?: 'openai' | 'anthropic';
}
export class OpenAICompatibleAdapter implements AgentAdapter {
  get billingModel(): string { return this.options.model; }
  readonly taskAccess = 'read-only' as const;
  readonly id = 'openai';
  readonly name = 'OpenAI Compatible';
  readonly skills = [{ id: 'json-task', name: 'JSON task' }];
  #key: string | undefined;
  constructor(readonly options: OpenAICompatibleOptions) {
    this.#key = options.apiKey ?? process.env[options.apiKeyEnv ?? 'OPENAI_API_KEY'];
  }
  validateInput(manifest: TaskManifest, input: Json): void { checkModelInputBudget(manifest, input); }
  async executeTask(context: AgentTaskContext): Promise<Json> {
    checkInputSize(context.input, context.preCallSizeLimits);
    const started = Date.now(),
      anthropic = this.options.apiStyle === 'anthropic';
    const endpoint =
      this.options.endpoint ??
      (this.options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '') +
        (anthropic ? '/messages' : '/chat/completions');
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.#key) {
      if (anthropic) {
        headers['x-api-key'] = this.#key;
        headers['anthropic-version'] = '2023-06-01';
      } else headers.authorization = 'Bearer ' + this.#key;
    }
    this.validateInput(context.manifest, context.input);
    const prompt = modelInputMessage(context.manifest, context.input);
    try {
      const response = await (this.options.fetch ?? fetch)(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers,
        body: JSON.stringify({
          model: this.options.model,
          messages: [
            { role: 'user', content: prompt },
          ],
          ...(anthropic
            ? { max_tokens: context.manifest.budget.maxOutputTokens }
            : {
                response_format: { type: 'json_object' },
                max_tokens: context.manifest.budget.maxOutputTokens,
              }),
        }),
        signal: context.signal,
      });
      if (!response.ok) throw new Error('PROVIDER_HTTP_' + response.status);
      const body = (await response.json()) as {
        choices?: { message: { content: string } }[];
        content?: { type: string; text?: string }[];
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          input_tokens?: number;
          output_tokens?: number;
          total_tokens?: number;
        };
      };
      if (!body.usage) throw new Error('PROVIDER_USAGE_REQUIRED');
      const u = body.usage;
      const inputTokens = u.prompt_tokens ?? u.input_tokens,
        outputTokens = u.completion_tokens ?? u.output_tokens;
      if (inputTokens === undefined || outputTokens === undefined)
        throw new Error('PROVIDER_USAGE_REQUIRED');
      context.reportUsage({
        inputTokens,
        outputTokens,
        totalTokens: u.total_tokens ?? inputTokens + outputTokens,
      });
      const content = anthropic
        ? body.content
            ?.filter((c) => c.type === 'text')
            .map((c) => c.text ?? '')
            .join('')
        : body.choices?.[0]?.message.content;
      if (!content) throw new Error('PROVIDER_EMPTY_RESULT');
      return parseJsonDeliverable(content);
    } finally {
      context.reportUsage({ wallTimeMs: Date.now() - started });
      context.reportIsolation?.('host_http_adapter');
    }
  }
}
