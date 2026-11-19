import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

// Build-only substitution for node:crypto. Core's canonicalization, DID decoding,
// signature metadata and invite/card policy verification remain unchanged.
export function createHash(algorithm) {
  if (algorithm !== 'sha256') throw new Error('UNSUPPORTED_HASH');
  const hash = sha256.create();
  return {
    update(value) {
      hash.update(typeof value === 'string' ? new TextEncoder().encode(value) : value);
      return this;
    },
    digest(encoding) {
      if (encoding !== 'hex') throw new Error('UNSUPPORTED_ENCODING');
      return bytesToHex(hash.digest());
    },
  };
}
export function createPublicKey({ format, type, key }) {
  const prefix = '302a300506032b6570032100';
  if (
    format !== 'der' ||
    type !== 'spki' ||
    key.length !== 44 ||
    bytesToHex(key.subarray(0, 12)) !== prefix
  )
    throw new Error('INVALID_PUBLIC_KEY');
  return key.subarray(12);
}
export function verify(algorithm, message, key, signature) {
  if (algorithm !== null) throw new Error('UNSUPPORTED_SIGNATURE');
  return ed25519.verify(signature, message, key, { zip215: false });
}
const unavailable = () => {
  throw new Error('BROWSER_VERIFICATION_ONLY');
};
export {
  unavailable as createCipheriv,
  unavailable as createDecipheriv,
  unavailable as createPrivateKey,
  unavailable as diffieHellman,
  unavailable as generateKeyPairSync,
  unavailable as hkdfSync,
  unavailable as randomBytes,
  unavailable as sign,
};
