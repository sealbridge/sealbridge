// SPDX-License-Identifier: Apache-2.0
import { digest } from './crypto.js';
/** WebAuthn challenges commit to displayed content as well as the one-use nonce. */
export function ownerApprovalChallenge(id: string, decision: string, binding: string): string {
  return digest({ type: 'SealbridgeOwnerApproval', version: 1, id, decision, binding }).slice(7);
}
export function ownerApprovalBinding(request: Record<string, unknown>): string {
  const { registration: _registration, challenge: _challenge, ...content } = request;
  return digest(content);
}
