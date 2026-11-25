const key = Symbol.for('sealbridge.preview-diagnostic-observations');

export function trackObservation(observation) {
  const pending = (globalThis[key] ??= new Set());
  pending.add(observation);
  void observation.finally(() => pending.delete(observation));
}

export default async function awaitPreviewDiagnostics() {
  // Playwright awaits global teardown before its webServer plugin teardown.
  // onTestEnd itself is not awaited. Share across its ESM/config loaders.
  await Promise.all(globalThis[key] ?? []);
}
