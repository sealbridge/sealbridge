import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { trackObservation } from './preview-diagnostic-teardown.mjs';
import {
  observeOrigin,
  previewPorts,
  readServerState,
  sanitizeDiagnostic,
} from './preview-diagnostics.mjs';

export default class PreviewDiagnosticReporter {
  constructor() {
    this.previousDirectory = process.env.SEALBRIDGE_TEST_PREVIEW_DIAGNOSTICS;
    try {
      this.directory = mkdtempSync(join(tmpdir(), 'sealbridge-preview-diagnostics-'));
      this.nonce = randomUUID();
      writeFileSync(join(this.directory, 'settings.json'), JSON.stringify({ nonce: this.nonce }));
      process.env.SEALBRIDGE_TEST_PREVIEW_DIAGNOSTICS = this.directory;
    } catch {
      delete process.env.SEALBRIDGE_TEST_PREVIEW_DIAGNOSTICS;
    }
  }

  onTestEnd(test, result) {
    if (result.status !== test.expectedStatus && result.status !== 'skipped') this.capture();
  }

  onError() {
    this.capture();
  }

  capture() {
    if (this.observation) return;
    // Start before Playwright tears down webServer; do not inspect test/error content.
    this.observation = Promise.all([
      this.directory ? readServerState(join(this.directory, 'state.jsonl')) : {},
      Promise.all(
        Object.entries(previewPorts).map(([target, port]) =>
          observeOrigin(target, port, this.nonce),
        ),
      ),
    ])
      .then(([server, origins]) => sanitizeDiagnostic({ server, origins }))
      .catch(() => sanitizeDiagnostic({}));
    trackObservation(this.observation);
  }

  async onEnd(result) {
    try {
      if (result.status !== 'passed' && this.observation) {
        process.stderr.write(JSON.stringify(await this.observation) + '\n');
      }
    } finally {
      if (this.previousDirectory === undefined)
        delete process.env.SEALBRIDGE_TEST_PREVIEW_DIAGNOSTICS;
      else process.env.SEALBRIDGE_TEST_PREVIEW_DIAGNOSTICS = this.previousDirectory;
      if (this.directory)
        await rm(this.directory, { recursive: true, force: true }).catch(() => {});
    }
    // No status override: diagnostics cannot turn a failed test into a pass.
  }
}
