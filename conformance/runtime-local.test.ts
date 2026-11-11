// SPDX-License-Identifier: Apache-2.0
import { expect, expectTypeOf, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { FileKeyStore, KeychainKeyStore, KeychainSecretStore, CommandAgentAdapter, SandboxAgentAdapter } from '../packages/runtime-local/src/index.js';
import type { KeyStore } from '../packages/runtime/src/key-store.js';
import type { SecretStore } from '../packages/runtime/src/secret-store.js';
import type { AgentAdapter, AgentTaskContext } from '../packages/runtime/src/adapter.js';

it('keeps local implementations compatible with common ports and workspace dependencies acyclic', () => {
  expectTypeOf<FileKeyStore>().toExtend<KeyStore>();
  expectTypeOf<KeychainKeyStore>().toExtend<KeyStore>();
  expectTypeOf<KeychainSecretStore>().toExtend<SecretStore>();
  expectTypeOf<CommandAgentAdapter>().toExtend<AgentAdapter>();
  expectTypeOf<SandboxAgentAdapter>().toExtend<AgentAdapter>();
  expectTypeOf<AgentTaskContext>().toEqualTypeOf<Parameters<CommandAgentAdapter['executeTask']>[0]>();
  const graph = new Map<string, string[]>();
  for (const name of readdirSync(new URL('../packages/', import.meta.url))) {
    const pkg = JSON.parse(readFileSync(new URL('../packages/' + name + '/package.json', import.meta.url), 'utf8'));
    graph.set(pkg.name, Object.keys(pkg.dependencies ?? {}).filter(dep => dep.startsWith('@acp/')));
  }
  expect(graph.get('@acp/runtime-local')?.sort()).toEqual(['@acp/core', '@acp/ledger', '@acp/relay', '@acp/sandbox']);
  function visit(name: string, path: string[]) {
    expect(path, 'dependency cycle at ' + name).not.toContain(name);
    for (const dep of graph.get(name) ?? []) visit(dep, [...path, name]);
  }
  for (const name of graph.keys()) visit(name, []);
});
