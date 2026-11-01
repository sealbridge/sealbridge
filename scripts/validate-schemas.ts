// SPDX-License-Identifier: Apache-2.0
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schemaRegistry, specDirectory } from '../packages/core/src/index.js';
const ajv = schemaRegistry();
for (const name of readdirSync(specDirectory).filter((x) => x.endsWith('.schema.json'))) {
  const schema = JSON.parse(readFileSync(new URL(name, specDirectory), 'utf8'));
  if (!ajv.validateSchema(schema)) throw new Error(name + ': ' + ajv.errorsText());
  if (!ajv.getSchema(name.slice(0, -12))) throw new Error('No schema for ' + name);
}
const examples = fileURLToPath(new URL('examples/', specDirectory));
for (const name of readdirSync(examples, { recursive: true }).filter((x): x is string => typeof x === 'string').filter((x) =>
  x.endsWith('.json'),
)) {
  const kind = basename(name).replace(/^sample-/, '').replace(/\.json$/, '');
  const validate = ajv.getSchema(kind);
  if (!validate) throw new Error('No schema for ' + name);
  if (!validate(JSON.parse(readFileSync(join(examples, name), 'utf8'))))
    throw new Error(name + ': ' + ajv.errorsText(validate.errors));
}
console.log('All Draft 2020-12 schemas and examples VALID');
