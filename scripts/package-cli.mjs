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
    else if (file.endsWith('.js')) {
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
await writeFile('dist/package.json', JSON.stringify({ type: 'module', version: root.version }));
console.log('Prepared standalone npm package in dist/');
