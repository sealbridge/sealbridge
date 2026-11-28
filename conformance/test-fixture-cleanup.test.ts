import { afterEach, expect, it, vi } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canRemoveTestFixture,
  removeTestFixture,
  removeTestFixtureSync,
} from './test-fixture-cleanup.mjs';

vi.mock('node:os', async (original) => {
  const os = await original<typeof import('node:os')>();
  return { ...os, userInfo: vi.fn(os.userInfo) };
});

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'acp-oci-guard-'));
  roots.push(root);
  writeFileSync(join(root, 'sentinel'), 'unchanged');
  return root;
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(userInfo).mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('removes only normal prefixed fixtures through sync and async entry points', async () => {
  for (const sync of [false, true]) {
    const root = fixture();
    const directory = mkdtempSync(join(root, 'acp-oci-'));
    writeFileSync(join(directory, 'fixture'), 'synthetic');
    const removal = vi.fn(rm);
    const removalSync = vi.fn(rmSync);
    if (sync) removeTestFixtureSync(directory, 'acp-oci-', removalSync);
    else await removeTestFixture(root + '/absent/../' + basename(directory), 'acp-oci-', removal);
    expect(sync ? removalSync : removal).toHaveBeenCalledOnce();
    expect(existsSync(directory)).toBe(false);
    expect(readFileSync(join(root, 'sentinel'), 'utf8')).toBe('unchanged');
  }
});

it('refuses old-layout cwd parent = dedicated TEMP, including its ancestors', async () => {
  const root = fixture(),
    temp = join(root, 'acp-oci-temp'),
    cwd = join(temp, 'old-workspace');
  mkdirSync(cwd, { recursive: true });
  for (const name of ['TEMP', 'TMP', 'TMPDIR']) vi.stubEnv(name, temp);
  const removal = vi.fn(),
    warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await removeTestFixture(dirname(cwd), 'acp-oci-', removal);
  removeTestFixtureSync(root, 'acp-oci-', removal);
  expect(removal).not.toHaveBeenCalled();
  expect(warning).toHaveBeenCalledTimes(2);
  expect(existsSync(cwd)).toBe(true);
  expect(readFileSync(join(root, 'sentinel'), 'utf8')).toBe('unchanged');
});

it.runIf(process.platform === 'linux')(
  'canonicalizes TMPDIR links and refuses linked candidates',
  async () => {
    const root = fixture(),
      target = join(root, 'acp-oci-target'),
      link = join(root, 'acp-oci-link');
    mkdirSync(target);
    symlinkSync(target, link, 'dir');
    vi.stubEnv('TMPDIR', link);
    const removal = vi.fn();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await removeTestFixture(target, 'acp-oci-', removal);
    await removeTestFixture(link, 'acp-oci-', removal);
    const child = mkdtempSync(join(target, 'acp-oci-'));
    await removeTestFixture(join(link, basename(child)), 'acp-oci-', removal);
    expect(removal).not.toHaveBeenCalled();
    expect(existsSync(child)).toBe(true);
    expect(readFileSync(join(root, 'sentinel'), 'utf8')).toBe('unchanged');
  },
);

it('refuses wrong prefixes, unknown protection roots, HOME, repository and cwd', async () => {
  const root = fixture(),
    removal = vi.fn();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await removeTestFixture(root, 'other-fixture-', removal);
  vi.stubEnv('TMPDIR', join(root, 'missing'));
  await removeTestFixture(root, 'acp-oci-', removal);
  vi.unstubAllEnvs();
  for (const protectedPath of [
    userInfo().homedir,
    process.cwd(),
    fileURLToPath(new URL('../', import.meta.url)),
  ])
    expect(canRemoveTestFixture(protectedPath, basename(protectedPath))).toBe(false);
  expect(removal).not.toHaveBeenCalled();
  expect(existsSync(root)).toBe(true);
});

it('preserves actual removal failures for tests that observe errno', async () => {
  const root = fixture(),
    failure = Object.assign(new Error('busy'), { code: 'EBUSY' });
  await expect(
    removeTestFixture(root, 'acp-oci-', async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(() =>
    removeTestFixtureSync(root, 'acp-oci-', () => {
      throw failure;
    }),
  ).toThrow(failure);
});

it('warns for an unresolved protection root using the normalized existing candidate', async () => {
  const root = fixture(),
    child = join(root, 'acp-oci-child');
  mkdirSync(child);
  vi.stubEnv('TMPDIR', join(root, 'missing-protection-root'));
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {}),
    removal = vi.fn();
  await removeTestFixture(root + '/absent/../acp-oci-child', 'acp-oci-', removal);
  expect(warning).toHaveBeenCalledOnce();
  expect(removal).not.toHaveBeenCalled();
  expect(existsSync(child)).toBe(true);
});

it('keeps other protections and permits a fixture when passwd lookup is unavailable', async () => {
  const root = fixture(),
    removal = vi.fn();
  vi.mocked(userInfo).mockImplementation(() => {
    throw new Error('no passwd entry');
  });
  await removeTestFixture(root, 'acp-oci-', removal);
  expect(removal).toHaveBeenCalledOnce();
  removal.mockClear();
  vi.stubEnv('HOME', root);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await removeTestFixture(root, 'acp-oci-', removal);
  expect(removal).not.toHaveBeenCalled();
  expect(readFileSync(join(root, 'sentinel'), 'utf8')).toBe('unchanged');
});

it.runIf(process.platform === 'darwin').each(['/var', '/tmp'])(
  'allows only the root-owned standard ancestor alias %s, never the alias itself',
  async (alias) => {
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    expect(lstatSync(alias).uid).toBe(0);
    expect(realpathSync.native(alias)).toBe('/private' + alias);
    // Only a fresh synthetic child is ever eligible; even success uses a deletion spy.
    const root = mkdtempSync(join(alias === '/var' ? '/var/tmp' : '/tmp', 'acp-oci-guard-'));
    roots.push(root);
    writeFileSync(join(root, 'sentinel'), 'unchanged');
    const removal = vi.fn();
    await removeTestFixture(root, 'acp-oci-', removal);
    expect(removal).toHaveBeenCalledOnce();
    removal.mockClear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await removeTestFixture(alias, basename(alias), removal);
    const link = join(root, 'acp-oci-nonstandard');
    symlinkSync(root, link, 'dir');
    await removeTestFixture(link, 'acp-oci-', removal);
    expect(removal).not.toHaveBeenCalled();
    expect(readFileSync(join(root, 'sentinel'), 'utf8')).toBe('unchanged');
  },
);

it.runIf(process.platform === 'win32')(
  'refuses protected roots with mixed long and 8.3 paths',
  async (context) => {
    const root = fixture(),
      longParent = join(root, 'long fixture parent for short path regression');
    mkdirSync(longParent);
    const shortParent = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:SEALBRIDGE_TEST_SHORT_PATH).ShortPath',
      ],
      { encoding: 'utf8', env: { ...process.env, SEALBRIDGE_TEST_SHORT_PATH: longParent } },
    ).trim();
    if (shortParent.toLowerCase() === longParent.toLowerCase()) {
      console.warn('[8.3 regression] no short alias was generated on this fixture volume');
      context.skip('8.3 alias unavailable on the dedicated fixture volume');
      return;
    }
    expect(realpathSync.native(shortParent).toLowerCase()).toBe(
      realpathSync.native(longParent).toLowerCase(),
    );
    const longPath = join(longParent, 'acp-oci-protected'),
      shortPath = join(shortParent, 'acp-oci-protected');
    mkdirSync(longPath);
    const removal = vi.fn();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const [candidate, protection] of [
      [longPath, shortPath],
      [shortPath, longPath],
    ]) {
      for (const name of ['TEMP', 'TMP', 'TMPDIR']) vi.stubEnv(name, protection);
      await removeTestFixture(candidate, 'acp-oci-', removal);
      removeTestFixtureSync(candidate, 'acp-oci-', removal);
    }
    expect(removal).not.toHaveBeenCalled();
    expect(readFileSync(join(root, 'sentinel'), 'utf8')).toBe('unchanged');
    console.info('[8.3 regression] short alias available; both long/short directions refused');
  },
);
