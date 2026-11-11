import { cp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
const root = JSON.parse(await readFile('package.json', 'utf8'));
const dirs = ['cli', 'examples/two-owner-demo', ...(await readdir('packages')).map(n => `packages/${n}`)];
const packages = new Map();
for (const dir of dirs) packages.set(JSON.parse(await readFile(`${dir}/package.json`, 'utf8')).name, dir);
await rm('dist', { recursive: true, force: true });
for (const dir of dirs) await cp(`${dir}/dist`, `dist/${dir}/dist`, { recursive: true });
for (const dir of ['spec', 'examples/two-owner-demo']) {
  if (dir === 'spec') await cp(dir, `dist/${dir}`, { recursive: true });
  else for (const name of ['alice-policy.json', 'bob-policy.json']) await cp(`${dir}/${name}`, `dist/${dir}/${name}`);
}
// Check the copied registry through its packaged module and relative spec path.
const { schemaRegistry, SCHEMA_NAMES, validateManifest, validateSchema } = await import('../dist/packages/core/dist/schema.js');
for (const name of SCHEMA_NAMES) {
  if (!schemaRegistry().getSchema(name)) throw new Error(`Missing packaged schema: ${name}`);
}
for (const version of ['0.1.0', '0.2.0']) {
  const manifest = JSON.parse(await readFile(`dist/spec/examples/sample-task-manifest.${version}.json`, 'utf8'));
  validateManifest(manifest);
  validateSchema('task-manifest', manifest);
}
async function rewrite(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await rewrite(file);
    // Declarations must resolve outside the workspace just like runtime imports.
    else if (file.endsWith('.js') || file.endsWith('.d.ts')) {
      let source = await readFile(file, 'utf8');
      source = source.replace(/(['"])(@acp\/[^'"]+)\1/g, (match, quote, name) => {
        const base = name.split('/').slice(0, 2).join('/');
        const target = packages.get(base);
        if (!target) throw new Error(`Unknown workspace import: ${name}`);
        const entry = name.slice(base.length + 1) || (base === '@acp/two-owner-demo' ? 'run-demo' : 'index');
        let relative = path.relative(path.dirname(file), `dist/${target}/dist/${entry}.js`).replaceAll('\\', '/');
        if (!relative.startsWith('.')) relative = './' + relative;
        return quote + relative + quote;
      });
      await writeFile(file, source);
    }
  }
}
await rewrite('dist');
// runtime-local is discovered with the other workspace packages above. Verify
// compatibility facades after rewriting, using only the standalone output.
if (!packages.has('@acp/runtime-local')) throw new Error('Missing runtime-local package');
for (const [legacyPath, localPath, names] of [
  ['packages/adapters/dist/command', 'command', ['CommandAgentAdapter', 'ClaudeCodeAdapter', 'CodexCliAdapter']],
  ['packages/adapters/dist/codex-config', 'codex-config', ['prepareCodexProxy']],
  ['packages/adapters/dist/windows-command', 'windows-command', ['windowsCommandCandidates']],
  ['packages/adapters/dist/credential-proxy', 'credential-proxy', ['startCredentialProxy']],
  ['packages/adapters/dist/sandbox', 'sandbox', ['SandboxAgentAdapter']],
  ['packages/runtime/dist/key-store', 'key-store', ['FileKeyStore', 'KeychainKeyStore', 'optionalKeyring']],
  ['packages/runtime/dist/local-identity', 'local-identity', []],
  ['packages/runtime/dist/secret-store', 'secret-store', ['KeychainSecretStore', 'openKeychainSecretStore']],
  ['cli/dist/wake-hook', 'wake-hook', []],
  ['cli/dist/receive-hook', 'receive-hook', []],
]) {
  const legacy = await import('../dist/' + legacyPath + '.js');
  const local = await import('../dist/packages/runtime-local/dist/' + localPath + '.js');
  for (const name of new Set([...names, ...Object.keys(local)])) {
    if (!(name in local) || legacy[name] !== local[name]) throw new Error('Local compatibility export differs: ' + legacyPath + ':' + name);
  }
}
const sdk = await import('../dist/cli/dist/sdk.js');
const localKeys = await import('../dist/packages/runtime-local/dist/key-store.js');
const localSecrets = await import('../dist/packages/runtime-local/dist/secret-store.js');
for (const name of ['FileKeyStore', 'KeychainKeyStore']) {
  if (sdk[name] !== localKeys[name]) throw new Error('SDK key store differs: ' + name);
}
if (sdk.KeychainSecretStore !== localSecrets.KeychainSecretStore) throw new Error('SDK secret store differs');
await writeFile('dist/package.json', JSON.stringify({ type: 'module', version: root.version }));
console.log('Prepared standalone npm package in dist/');

// A second, self-contained publish root; mainline dist and manifest are unchanged.
await rm('dist-local', { recursive: true, force: true });
await mkdir('dist-local', { recursive: true });
for (const entry of root.files) {
  await mkdir(path.dirname('dist-local/' + entry), { recursive: true });
  await cp(entry, 'dist-local/' + entry, { recursive: true });
}
const { scripts: _scripts, ...localManifest } = root;
await writeFile('dist-local/package.json', JSON.stringify({ ...localManifest,
  name: 'sealbridge-local', bin: { 'sealbridge-local': './dist/cli/dist/index.js' },
}, null, 2) + '\n');
await writeFile('dist-local/dist/cli/dist/distribution.js', 'export const LOCAL_DISTRIBUTION = true;\n');
console.log('Prepared standalone sealbridge-local npm package in dist-local/');
