// SPDX-License-Identifier: Apache-2.0
import type { SignedAgentCard } from '@acp/core';
export interface PublicSettings {
  public: boolean;
  taskTypes: string[];
  maxInputTokens: number;
  maxOutputTokens: number;
  maxToolCalls: number;
  maxWallSeconds: number;
  maxJobsPerPersonPerMinute: number;
  maxJobsPerDay: number;
  alwaysAsk: boolean;
}
export function publicSettingsFlags(s: PublicSettings): string[] {
  if (!s || Object.keys(s).sort().join(',') !== ['public','taskTypes','maxInputTokens','maxOutputTokens',
      'maxToolCalls','maxWallSeconds','maxJobsPerPersonPerMinute','maxJobsPerDay','alwaysAsk'].sort().join(',') ||
      typeof s.public !== 'boolean' || typeof s.alwaysAsk !== 'boolean' || !Array.isArray(s.taskTypes) || !s.taskTypes.length ||
      s.taskTypes.some(t => typeof t !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(t))) throw new Error('INVALID_PUBLIC_SETTINGS');
  if (!s.alwaysAsk) throw new Error('CONNECTION_OPENING_REQUIRED: Set alwaysAsk:true; connections require inspection and owner opening.');
  const mapping = { maxInputTokens: 'max-input-tokens', maxOutputTokens: 'max-output-tokens',
    maxToolCalls: 'max-tool-invocations', maxWallSeconds: 'max-wall-clock-seconds',
    maxJobsPerPersonPerMinute: 'max-requests-per-minute', maxJobsPerDay: 'max-tasks-per-day' } as const;
  for (const field of Object.keys(mapping) as (keyof typeof mapping)[])
    if (!Number.isSafeInteger(s[field]) || s[field] < 1) throw new Error('INVALID_PUBLIC_SETTINGS');
  const flags = ['--max-tasks-per-day', String(s.maxJobsPerDay)];
  if (s.public) flags.push('--publish');
  flags.push('--allow-task-type', [...new Set(s.taskTypes)].join(','));
  for (const field of Object.keys(mapping) as (keyof typeof mapping)[])
    if (field !== 'maxJobsPerDay') flags.push('--' + mapping[field], String(s[field]));
  return flags;
}
export function publicProfileSummary(card: SignedAgentCard, rate?: number, daily?: number, automatic = false, budgets: Record<string, number | undefined> = {}) {
  return { name: card.payload.name, access: 'Connection-based intake; unconnected requests held',
    jobs: card.payload.skills.flatMap(s => s.taskTypes ?? []),
    hostLimits: { perPersonPerMinute: rate ?? null, perDay: daily ?? null, dayReset: '00:00 UTC' },
    approval: 'Inspection and owner opening required for limited peers', inspection: 'unavailable',
    perJob: budgets, automaticPolicy: automatic, signedCard: card };
}
