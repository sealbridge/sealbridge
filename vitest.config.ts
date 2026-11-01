import { defineConfig } from 'vitest/config';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Installer checks run before build. Resolve CLI helper dependencies
// from source when their compiled entries are absent; built-suite mocks retain
// their existing workspace module paths.
const unbuiltHelpers = [
  ['@acp/runtime/application-config', 'packages/runtime', 'application-config'],
  ['@acp/runtime/local-identity', 'packages/runtime', 'local-identity'],
  ['@acp/runtime/relay-selection', 'packages/runtime', 'relay-selection'],
  ['@acp/core', 'packages/core', 'index'],
].flatMap(([find, directory, entry]) => existsSync(new URL(`./${directory}/dist/${entry}.js`, import.meta.url))
  ? [] : [{ find, replacement: fileURLToPath(new URL(`./${directory}/src/${entry}.ts`, import.meta.url)) }]);
export default defineConfig({ resolve: { alias: unbuiltHelpers }, test: { include: ['conformance/**/*.test.ts'], setupFiles: ['conformance/application-test-env.ts'], testTimeout: 20000, fileParallelism: false } });
