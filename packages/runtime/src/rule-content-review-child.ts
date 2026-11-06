// SPDX-License-Identifier: Apache-2.0
// Fixed compiled scanner. The only input is projected JSON on IPC; no source is evaluated.
import { inspectRuleContent } from '@acp/core';
import type { RuleInspectionInput, RuleInspectionOptions } from '@acp/core';

const MAX_REQUEST_BYTES = 256 * 1024 + 4096;
const MAX_RESULT_BYTES = 64 * 1024;
process.once('message', async (message: unknown) => {
  try {
    if (typeof message !== 'string' || Buffer.byteLength(message) > MAX_REQUEST_BYTES) process.exit(1);
    const request = JSON.parse(message) as { content: RuleInspectionInput; limits?: RuleInspectionOptions };
    const report = await inspectRuleContent(request.content, request.limits);
    const output = JSON.stringify(report);
    if (Buffer.byteLength(output) > MAX_RESULT_BYTES || !process.send) process.exit(1);
    process.send(output, error => {
      if (error) process.exit(1);
      process.disconnect();
    });
  } catch { process.exit(1); }
});
