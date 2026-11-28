// SPDX-License-Identifier: Apache-2.0
import { isAbsolute } from 'node:path';

/** Explicit trusted host test configuration, never a product/runtime option. */
export function ociTestExecutable(binary: string): string {
  const executable = process.env.SEALBRIDGE_TEST_DOCKER_EXE;
  if (binary !== 'docker' || !executable) return binary;
  if (
    process.platform !== 'win32' ||
    process.env.SEALBRIDGE_OCI_INTEGRATION !== '1' ||
    process.env.SEALBRIDGE_OCI_RUNTIME !== 'docker' ||
    !isAbsolute(executable)
  )
    throw new Error('INVALID_OCI_TEST_TRANSPORT');
  return executable;
}
