// SPDX-License-Identifier: Apache-2.0
import { digest, signPayload, verifySigned } from './crypto.js';
import { verifyContract } from './contract.js';
import type { TaskContract } from './contract.js';
import { validateManifest, validateSchema } from './schema.js';
import type { DelegationLimits, DelegationLink, DelegationProof, KeyPair, TaskManifest } from './types.js';

const maxima = ['maxInputTokens', 'maxOutputTokens', 'maxToolInvocations', 'maxWallClockSeconds'] as const;
const equal = (a: unknown, b: unknown) => digest(a) === digest(b);
function fail(code = 'DELEGATION_INVALID'): never { throw new Error(code); }
function time(value: string): number {
  const n = Date.parse(value);
  if (!Number.isFinite(n)) fail();
  return n;
}
function root(manifest: TaskManifest): void {
  if (manifest.protocolVersion !== '0.2.0' || manifest.contextGrant?.deliveryMode !== 'approval_redelegation')
    fail('DELEGATION_INVALID');
  if (manifest.permissions.maxDelegationDepth !== 1) fail('DELEGATION_INVALID');
}
/** Literal declaration comparison only; it does not interpret selectors or inspect provenance. */
export function assertDelegationAttenuation(parent: TaskManifest, child: TaskManifest): void {
  root(parent);
  try { validateManifest(parent); validateManifest(child); } catch { fail(); }
  const p = parent.contextGrant!, c = child.contextGrant;
  if (!c || c.deliveryMode !== 'view_only' || c.retention !== 'ephemeral_view' || c.inputRetentionAllowed === true)
    fail('DELEGATION_INVALID');
  if (child.permissions.maxDelegationDepth !== 0) fail('DELEGATION_INVALID');
  if (child.permissions.grantedCapabilities.length) fail('DELEGATION_INVALID');
  if (time(child.createdAt) < time(parent.createdAt) || time(child.deadline) <= time(child.createdAt) ||
      time(parent.deadline) <= time(parent.createdAt)) fail();
  if (time(child.deadline) > time(parent.deadline) || time(c.expiresAt) > time(p.expiresAt) || c.maxBytes > p.maxBytes)
    fail('DELEGATION_INVALID');
  for (const name of maxima) if (child.budget[name] > parent.budget[name]) fail('DELEGATION_INVALID');
  const withoutMaxima = (m: TaskManifest) => Object.fromEntries(Object.entries(m.budget).filter(([k]) => !maxima.includes(k as typeof maxima[number])));
  if (!equal(withoutMaxima(parent), withoutMaxima(child)) || !equal(parent.sandboxPolicy, child.sandboxPolicy) ||
      !equal(parent.verification, child.verification)) fail('DELEGATION_INVALID');
  if (!c.selectors.length || c.selectors.some(s => !p.selectors.includes(s)) ||
      p.fieldsAllowed && (!c.fieldsAllowed?.length || c.fieldsAllowed.some(f => !p.fieldsAllowed!.includes(f))) ||
      c.fieldsAllowed && !c.fieldsAllowed.length ||
      p.fieldsDenied?.some(f => !c.fieldsDenied?.includes(f)) ||
      p.outputSchema !== undefined && (c.outputSchema === undefined || !equal(p.outputSchema, c.outputSchema)))
    fail('DELEGATION_INVALID');
  const narrower = c.selectors.length < p.selectors.length ||
    (p.fieldsAllowed ? !!c.fieldsAllowed && c.fieldsAllowed.length < p.fieldsAllowed.length : !!c.fieldsAllowed?.length);
  if (!narrower) fail('DELEGATION_INVALID');
}
function actualLimits(child: TaskManifest): DelegationLimits {
  return structuredClone({ deadline: child.deadline, expiresAt: child.contextGrant!.expiresAt,
    budget: child.budget, sandboxPolicy: child.sandboxPolicy, verification: child.verification,
    depthRemaining: child.permissions.maxDelegationDepth });
}
/** Historical verification has no implicit current clock. Siblings are separate one-edge chains. */
export function verifyDelegationChain(input: { rootContract: TaskContract; chain: readonly DelegationProof[] }):
  { depthRemaining: number; delegateeOwnerDids: string[] } {
  const { rootContract: parent, chain } = input;
  if (!verifyContract(parent)) fail();
  root(parent.manifest);
  if (!Array.isArray(chain) || !chain.length) fail('DELEGATION_PROOF_REQUIRED');
  if (chain.length > 1 || chain.length > parent.manifest.permissions.maxDelegationDepth) fail('DELEGATION_INVALID');
  const proof = chain[0];
  try { validateSchema('delegation-attachment', { parentContract: parent, children: [proof] }); } catch { fail(); }
  const child = proof.childContract, link = proof.link, l = link.payload;
  if (!verifyContract(child)) fail();
  const a = parent.manifest.requester.ownerDid, b = parent.manifest.worker!.ownerDid, c = child.manifest.worker!.ownerDid;
  if (new Set([a, b, c]).size !== 3 || b !== child.manifest.requester.ownerDid ||
      parent.manifest.taskId === child.manifest.taskId || !verifySigned(link, b) ||
      l.delegatorOwnerDid !== b || l.delegateeOwnerDid !== c || l.parentTaskId !== parent.manifest.taskId ||
      l.childTaskId !== child.manifest.taskId || l.parentContractDigest !== parent.contractDigest ||
      l.childContractDigest !== child.contractDigest || l.prevLinkDigest !== null) fail();
  const remaining = parent.manifest.permissions.maxDelegationDepth - 1;
  if (l.depthRemaining !== remaining || l.limits.depthRemaining !== remaining || child.manifest.permissions.maxDelegationDepth !== remaining)
    fail('DELEGATION_INVALID');
  assertDelegationAttenuation(parent.manifest, child.manifest);
  if (!equal(l.limits, actualLimits(child.manifest))) fail('DELEGATION_INVALID');
  const issued = time(l.issuedAt);
  if (l.issuedAt !== link.signature.signedAt || time(child.acceptance.signature.signedAt) > issued ||
      time(child.manifest.createdAt) > time(child.acceptance.signature.signedAt) ||
      [parent.manifest, child.manifest].some(m => issued >= time(m.deadline) || issued >= time(m.contextGrant!.expiresAt))) fail();
  return { depthRemaining: remaining, delegateeOwnerDids: [c] };
}
export function createDelegationLink(input: { parentContract: TaskContract; childContract: TaskContract; issuedAt?: string }, delegator: KeyPair): DelegationLink {
  const { parentContract: parent, childContract: child } = input;
  if (!verifyContract(parent) || !verifyContract(child)) fail();
  assertDelegationAttenuation(parent.manifest, child.manifest);
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  time(issuedAt);
  let link: DelegationLink;
  try { link = signPayload({ type: 'DelegationLink' as const, parentTaskId: parent.manifest.taskId,
    parentContractDigest: parent.contractDigest, childTaskId: child.manifest.taskId,
    childContractDigest: child.contractDigest, delegatorOwnerDid: delegator.did,
    delegateeOwnerDid: child.manifest.worker!.ownerDid, depthRemaining: 0, limits: actualLimits(child.manifest),
    issuedAt, prevLinkDigest: null }, delegator, issuedAt);
  } catch { fail(); }
  verifyDelegationChain({ rootContract: parent, chain: [{ link, childContract: child }] });
  return link;
}
