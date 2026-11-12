// SPDX-License-Identifier: Apache-2.0
/** Owner-controlled admission, independent of durable connection consent. */
export interface AutoAcceptPolicy {
  version: 1;
  enabled: boolean;
  from: 'invited' | 'connected' | 'anyone';
  work: 'read-only' | 'write';
  /** Size caps have defaults; omitted daily/monthly caps mean unlimited. Unknown limits fail closed. */
  limits: {
    maxDiffLines?: number;
    maxDiffBytes?: number;
    maxDiffFiles?: number;
    maxTasksPerDayPerDid?: number;
    maxMonthlyUsd?: number;
    monthlyLimitMessage?: 'standard' | 'trial-reviewer';
  };
}
export const DEFAULT_AUTO_ACCEPT_POLICY: Readonly<AutoAcceptPolicy> = Object.freeze({
  version: 1, enabled: true, from: 'connected', work: 'read-only', limits: Object.freeze({}),
});
export function validAutoAcceptPolicy(value: unknown): value is AutoAcceptPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as AutoAcceptPolicy;
  return Object.keys(p).every(k => ['version', 'enabled', 'from', 'work', 'limits'].includes(k)) &&
    p.version === 1 && typeof p.enabled === 'boolean' &&
    ['invited', 'connected', 'anyone'].includes(p.from) && ['read-only', 'write'].includes(p.work) &&
    !!p.limits && typeof p.limits === 'object' && !Array.isArray(p.limits) &&
    Object.keys(p.limits).every(k => ['maxDiffLines', 'maxDiffBytes', 'maxDiffFiles', 'maxTasksPerDayPerDid', 'maxMonthlyUsd', 'monthlyLimitMessage'].includes(k)) &&
    (['maxDiffLines', 'maxDiffBytes', 'maxDiffFiles'] as const).every(k => p.limits[k] === undefined || Number.isSafeInteger(p.limits[k]) && p.limits[k]! >= 1) &&
    (p.limits.maxTasksPerDayPerDid === undefined ||
      Number.isSafeInteger(p.limits.maxTasksPerDayPerDid) && p.limits.maxTasksPerDayPerDid >= 1) &&
    (p.limits.maxMonthlyUsd === undefined || typeof p.limits.maxMonthlyUsd === 'number' &&
      Number.isFinite(p.limits.maxMonthlyUsd) && p.limits.maxMonthlyUsd > 0 &&
      Number.isSafeInteger(Math.round(p.limits.maxMonthlyUsd * 1e9)) &&
      Math.round(p.limits.maxMonthlyUsd * 1e9) > 0 &&
      Math.abs(p.limits.maxMonthlyUsd * 1e9 - Math.round(p.limits.maxMonthlyUsd * 1e9)) <=
        Math.max(1e-6, Number.EPSILON * Math.abs(p.limits.maxMonthlyUsd * 1e9))) &&
    (p.limits.monthlyLimitMessage === undefined || ['standard', 'trial-reviewer'].includes(p.limits.monthlyLimitMessage));
}
export function autoAcceptPolicy(value: unknown = DEFAULT_AUTO_ACCEPT_POLICY): AutoAcceptPolicy {
  if (!validAutoAcceptPolicy(value)) throw new Error('AUTO_ACCEPT_POLICY_INVALID');
  return structuredClone(value);
}
