// SPDX-License-Identifier: Apache-2.0
import type { ApprovalRequest } from '@acp/runtime';
import { literalText } from './task-review.js';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
// Remote text should not be able to control the terminal displaying an approval.
function display(value: unknown): string {
  return (typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? 'unknown')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}
export function approvalSummary(request: ApprovalRequest): string {
  const details = record(request.details), manifest = record(details.manifest);
  const lines = [`Approval: ${request.gate}`, `Task: ${request.taskId}`];
  if (request.gate === 'contract_acceptance') {
    const budget = record(manifest.budget), input = details.input;
    const diff = record(input).diff;
    const size = typeof diff === 'string'
      ? `${diff === '' ? 0 : diff.split('\n').length - (diff.endsWith('\n') ? 1 : 0)} diff lines, ${Buffer.byteLength(diff)} bytes`
      : `${Buffer.byteLength(JSON.stringify(input) ?? '')} bytes (JSON)`;
    lines.push(`From: ${display(record(manifest.requester).ownerDid ?? details.from)}`,
      `Title: ${display(record(manifest.task).title)}`, `Input: ${size}`,
      `Time limit: ${display(budget.maxWallClockSeconds)} seconds`,
      `Budget: input ${display(budget.maxInputTokens)} tokens; output ${display(budget.maxOutputTokens)} tokens; tools ${display(budget.maxToolInvocations)}`);
    lines.push('Task content (literal JSON):', literalText({ manifest, input,
      capabilities: details.capabilities ?? [] }));
  } else if (request.gate === 'final_verification') {
    const data = record(record(record(request.target).artifact).payload).data;
    lines.push('Review result:', display(data));
  } else {
    // Side effects and budget changes still display the full action being approved.
    lines.push('Action:', display(request.target), 'Details:', display(request.details));
  }
  lines.push('Use --verbose when starting this command to display full approval details.');
  return lines.join('\n');
}
