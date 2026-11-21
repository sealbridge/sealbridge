// Match Cloudflare's ordered append/detach semantics, rather than treating a
// narrow rule as an override. https://developers.cloudflare.com/workers/static-assets/headers/
export function headerRules(source) {
  const rules = [];
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (line.startsWith('/')) rules.push({ route: line.trim(), operations: [] });
    else if (rules.length) {
      const text = line.trim(),
        colon = text.indexOf(':');
      if (text.startsWith('! '))
        rules.at(-1).operations.push({ name: text.slice(2).trim(), detach: true });
      else if (colon > 0)
        rules.at(-1).operations.push({
          name: text.slice(0, colon).trim(),
          value: text.slice(colon + 1).trim(),
        });
    }
  }
  return rules;
}
export function headersFor(rules, pathname) {
  const values = new Map();
  for (const rule of rules) {
    if (rule.route !== '/*' && rule.route !== pathname) continue;
    for (const operation of rule.operations) {
      const key = operation.name.toLowerCase();
      if (operation.detach) values.delete(key);
      else
        values.set(key, {
          name: operation.name,
          value: values.has(key) ? values.get(key).value + ', ' + operation.value : operation.value,
        });
    }
  }
  return Object.fromEntries([...values.values()].map(({ name, value }) => [name, value]));
}
