// Test teardown only: a path guard, not proof of creation or a race-proof deleter.
import { lstatSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const contains = (parent, child) => {
  const part = relative(parent, child);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep));
};

function checkDirectory(entry, candidate) {
  const stat = lstatSync(entry);
  if (stat.isSymbolicLink()) {
    const target = resolve(dirname(entry), readlinkSync(entry));
    if (
      entry === candidate ||
      process.platform !== 'darwin' ||
      stat.uid !== 0 ||
      !['/var', '/tmp'].includes(entry) ||
      target !== '/private' + entry
    )
      throw new Error('linked path');
    // Match local-identity's two system aliases, including checking their targets.
    checkDirectory(target, candidate);
  } else if (!stat.isDirectory()) throw new Error('non-directory path');
  if (dirname(entry) !== entry) checkDirectory(dirname(entry), candidate);
}

export function canRemoveTestFixture(path, prefix) {
  let candidate;
  try {
    if (
      typeof path !== 'string' ||
      !isAbsolute(path) ||
      !prefix ||
      !basename(path).startsWith(prefix)
    )
      throw new Error('unexpected fixture path');
    candidate = resolve(path);
    // Check every lexical component: realpath alone would hide a junction/link.
    checkDirectory(candidate, candidate);
    const actual = realpathSync.native(candidate);
    const protectedPaths = [
      tmpdir(),
      homedir(),
      repository,
      process.cwd(),
      parse(actual).root,
      ...['TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA']
        .map((name) => process.env[name])
        .filter(Boolean),
    ];
    // Minimal containers may have no passwd entry; retain all other protections.
    try {
      protectedPaths.push(userInfo().homedir);
    } catch {
      /* no passwd entry */
    }
    for (const protectedPath of protectedPaths) {
      if (!isAbsolute(protectedPath)) throw new Error('relative protection root');
      if (contains(actual, realpathSync.native(protectedPath)))
        throw new Error('protected root or ancestor');
    }
    return true;
  } catch (error) {
    // Already removed by the product is normal; an unresolved protection root is not.
    if (candidate !== undefined && error?.code === 'ENOENT') {
      try {
        lstatSync(candidate);
      } catch (missing) {
        if (missing?.code === 'ENOENT') return false;
      }
    }
    console.warn('[test fixture cleanup] retained; unsafe or unverifiable path:', path);
    return false;
  }
}

export async function removeTestFixture(path, prefix, remove = rm) {
  if (canRemoveTestFixture(path, prefix))
    await remove(resolve(path), { recursive: true, force: true });
}

export function removeTestFixtureSync(path, prefix, remove = rmSync) {
  if (canRemoveTestFixture(path, prefix)) remove(resolve(path), { recursive: true, force: true });
}
