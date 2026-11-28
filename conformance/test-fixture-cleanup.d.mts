export function canRemoveTestFixture(path: string, prefix: string): boolean;
export function removeTestFixture(
  path: string,
  prefix: string,
  remove?: typeof import('node:fs/promises').rm,
): Promise<void>;
export function removeTestFixtureSync(
  path: string,
  prefix: string,
  remove?: typeof import('node:fs').rmSync,
): void;
