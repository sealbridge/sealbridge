// SPDX-License-Identifier: Apache-2.0
import { validateRelayEndpointUrl } from '@acp/core';
import type { RelayTransport } from '@acp/relay';

export const DEFAULT_PUBLIC_RELAY = 'https://relay.sealbridge.dev';
export function normalizeRelayUrl(value: string): string {
  const url = new URL(value);
  return url.origin + url.pathname.replace(/\/+$/, '');
}
export interface RelaySelectionOptions {
  configured?: RelayTransport | string;
  explicit?: string;
  /** Must come from an already verified invitation. */
  inviteRelay?: string;
  allowPrivateRelay?: boolean;
  allowAnyRelay?: boolean;
  allowedRelayUrls?: string[];
  conflictError?: string;
}
/** Keep an injected transport or explicit pin distinct from the implicit public fallback. */
export function selectApplicationRelay(options: RelaySelectionOptions = {}): {
  relay: RelayTransport | string;
  source: 'transport' | 'configured' | 'explicit' | 'invite' | 'default';
} {
  const { configured, explicit, inviteRelay } = options;
  const transport = configured !== undefined && typeof configured !== 'string';
  const relay = configured && transport ? configured : explicit ?? configured ?? inviteRelay ?? DEFAULT_PUBLIC_RELAY;
  const urls = [explicit, typeof configured === 'string' ? configured : undefined, inviteRelay,
    typeof relay === 'string' ? relay : undefined].filter((v): v is string => v !== undefined);
  for (const url of urls) validateRelayEndpointUrl(url, options);
  if (options.allowedRelayUrls !== undefined) {
    const allow = new Set(options.allowedRelayUrls.map(normalizeRelayUrl));
    if (urls.some(url => !allow.has(normalizeRelayUrl(url))))
      throw new Error(options.conflictError ?? 'CONFLICTING_RELAY');
  } else if (!options.allowAnyRelay) {
    if (typeof configured === 'string' && [explicit, inviteRelay].some(url =>
      url !== undefined && normalizeRelayUrl(url) !== normalizeRelayUrl(configured)))
      throw new Error(options.conflictError ?? 'CONFLICTING_RELAY');
    if (transport && explicit !== undefined) throw new Error(options.conflictError ?? 'CONFLICTING_RELAY');
  }
  if (options.allowedRelayUrls === undefined && !options.allowAnyRelay && explicit !== undefined && inviteRelay !== undefined &&
      normalizeRelayUrl(explicit) !== normalizeRelayUrl(inviteRelay))
    throw new Error(options.conflictError ?? 'CONFLICTING_RELAY');
  return { relay, source: transport ? 'transport' : explicit ? 'explicit' : configured ? 'configured'
    : inviteRelay ? 'invite' : 'default' };
}
