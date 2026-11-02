// SPDX-License-Identifier: Apache-2.0
import { signPayload, verifySignature, verifySigned, resolveDid, canonicalize } from './crypto.js';
import type { BudgetSpec, Json, KeyPair, Signature, Signed } from './types.js';
export interface AgentSkill {
  id: string;
  name: string;
  description?: string;
  taskTypes?: string[];
  inputSchema?: Json;
  outputSchema?: Json;
}
/** Lifetime applied when createSignedAgentCard is not given an explicit expiresAt. */
export const DEFAULT_AGENT_CARD_EXPIRY_MS = 24 * 60 * 60 * 1000;
/** Longest allowed expiresAt - signedAt window. Matches the invite TTL cap of 30 days. */
export const MAX_AGENT_CARD_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
/** Allowed future clock skew for newly minted invites, capability tokens, and task manifests. */
export const DEFAULT_CLOCK_SKEW_MS = 60_000;
/**
 * Statement signed by agentDid's key when the card owner is a different DID.
 * Binds ownerDid, agentDid, relayEndpoint, and expiresAt. A signature for one tuple
 * does not authorize a different owner, agent, relay, or expiry.
 */
export interface AgentCardDelegation {
  type: 'AgentCardDelegation';
  ownerDid: string;
  agentDid: string;
  relayEndpoint: string;
  expiresAt: string;
}
export function agentCardDelegationStatement(fields: {
  ownerDid: string;
  agentDid: string;
  relayEndpoint: string;
  expiresAt: string;
}): AgentCardDelegation {
  return {
    type: 'AgentCardDelegation',
    ownerDid: fields.ownerDid,
    agentDid: fields.agentDid,
    relayEndpoint: fields.relayEndpoint,
    expiresAt: fields.expiresAt,
  };
}
export type OpenPolicy = Partial<Pick<BudgetSpec,
  'maxInputTokens' | 'maxOutputTokens' | 'maxToolInvocations' | 'maxWallClockSeconds'>>;
export const OPEN_POLICY_FIELDS = [
  'maxInputTokens', 'maxOutputTokens', 'maxToolInvocations', 'maxWallClockSeconds',
] as const;

/** Bounded version identifiers retain future advertisements without interpreting them. */
function validProtocolVersions(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length > 0 && value.length <= 16 &&
    value.every(version => typeof version === 'string' && version.length <= 64 &&
      /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$(?![\s\S])/.test(version)) &&
    new Set(value).size === value.length);
}

function validOpenPolicy(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, limit]) =>
    OPEN_POLICY_FIELDS.some((field) => field === key) &&
    typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0);
}

export interface DiscoveryAgentCard {
  type: 'AgentCard';
  /** Accepted manifest versions; omission denotes a legacy 0.1.0 peer. */
  protocolVersions?: string[];
  accessMode?: 'invite-only' | 'open';
  openPolicy?: OpenPolicy;
  name: string;
  description: string;
  ownerDid: string;
  agentDid: string;
  relayEndpoint: string;
  skills: AgentSkill[];
  costModes: BudgetSpec['costBearer'][];
  version: string;
  /** ISO-8601 timestamp after which the card must be rejected. */
  expiresAt: string;
  /**
   * Signature by agentDid over agentCardDelegationStatement.
   * Required when agentDid differs from ownerDid, and absent when they are the same key.
   */
  agentDelegation?: Signature;
}
export type CreateAgentCardOptions = Omit<
  DiscoveryAgentCard,
  'type' | 'ownerDid' | 'version' | 'description' | 'costModes' | 'expiresAt' | 'agentDelegation'
> &
  Partial<Pick<DiscoveryAgentCard, 'version' | 'description' | 'costModes' | 'expiresAt'>> & {
    /** Key that controls agentDid. Required when agentDid is not owner.did. */
    agentKey?: KeyPair;
  };
export type SignedAgentCard = Signed<DiscoveryAgentCard>;
function relayUrl(value: string): void {
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password)
    throw new Error('INVALID_RELAY_URL');
}
export interface RelayEndpointPolicy {
  /** Private and loopback relays are blocked unless this is exactly true. */
  allowPrivateRelay?: boolean;
}
function ssrfBlocked(): never {
  throw new Error('SSRF_BLOCKED_RELAY_URL');
}
function normalizeHost(value: string): string {
  return value.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0].replace(/\.+$/, '');
}
function parseNumericPart(part: string): number | undefined {
  if (/^0x[0-9a-f]+$/i.test(part)) return parseInt(part, 16);
  // Leading zeros are octal for inet_aton. A bare 0 stays decimal zero.
  if (/^0[0-7]+$/.test(part)) return parseInt(part, 8);
  if (/^\d+$/.test(part)) return Number(part);
  return undefined;
}
/** inet_aton forms: a, a.b, a.b.c, a.b.c.d, including hex and octal parts. */
function decodeInetAton(host: string): [number, number, number, number] | undefined {
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return undefined;
  const nums = parts.map(parseNumericPart);
  if (nums.some((n) => n === undefined || !Number.isSafeInteger(n))) return undefined;
  const values = nums as number[];
  const limits =
    values.length === 1
      ? [0x100000000]
      : values.length === 2
        ? [0x100, 0x1000000]
        : values.length === 3
          ? [0x100, 0x100, 0x10000]
          : [0x100, 0x100, 0x100, 0x100];
  let packed = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i] < 0 || values[i] >= limits[i]) return undefined;
    packed = packed * limits[i] + values[i];
  }
  if (packed > 0xffffffff) return undefined;
  return [(packed >>> 24) & 255, (packed >>> 16) & 255, (packed >>> 8) & 255, packed & 255];
}
function isCanonicalIpv4(host: string): boolean {
  return /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(host);
}
function isNonCanonicalIpv4(host: string): boolean {
  if (!host || host.includes(':')) return false;
  if (isCanonicalIpv4(host)) {
    const parts = host.split('.').map(Number);
    return parts.some((n) => n > 255);
  }
  return partsLookNumeric(host);
}
function partsLookNumeric(host: string): boolean {
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return false;
  return parts.every((part) => /^0x[0-9a-f]+$/i.test(part) || /^\d+$/.test(part));
}
function wordPairToIpv4(hi: number, lo: number): [number, number, number, number] {
  return [hi >> 8, hi & 255, lo >> 8, lo & 255];
}
function parseIpv6Words(host: string): number[] | undefined {
  let body = host;
  if (body.includes('.')) {
    const last = body.lastIndexOf(':');
    if (last < 0) return undefined;
    const tail = decodeInetAton(body.slice(last + 1));
    if (!tail) return undefined;
    const hi = ((tail[0] << 8) | tail[1]).toString(16);
    const lo = ((tail[2] << 8) | tail[3]).toString(16);
    body = body.slice(0, last + 1) + hi + ':' + lo;
  }
  const halves = body.split('::');
  if (halves.length > 2) return undefined;
  const parseSide = (side: string): number[] | undefined => {
    if (!side) return [];
    const words = side.split(':');
    const parsed: number[] = [];
    for (const word of words) {
      if (!/^[0-9a-f]{1,4}$/i.test(word)) return undefined;
      parsed.push(parseInt(word, 16));
    }
    return parsed;
  };
  const left = parseSide(halves[0]);
  const right = halves.length === 2 ? parseSide(halves[1]) : [];
  if (!left || !right) return undefined;
  if (halves.length === 1) return left.length === 8 ? left : undefined;
  if (left.length + right.length > 7) return undefined;
  return [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
}
/**
 * Unspecified, link-local, metadata, multicast, and reserved ranges are always blocked.
 * Loopback, RFC1918, CGNAT, benchmarking, documentation, and ULA ranges are blocked
 * unless allowPrivateRelay is exactly true.
 */
function ipv4Disallowed(octets: number[], privateBlocked: boolean): boolean {
  const [a, b, c] = octets;
  if (a === undefined || b === undefined || c === undefined || octets[3] === undefined) return true;
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  if (a === 0 || (a === 169 && b === 254) || a >= 224) return true;
  if (!privateBlocked) return false;
  if (a === 127 || a === 10 || (a === 100 && b >= 64 && b <= 127)) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return false;
}
function assertIpv6Allowed(words: number[], privateBlocked: boolean): void {
  if (words.length !== 8) ssrfBlocked();
  if (words.every((word) => word === 0)) ssrfBlocked();
  if (
    words[0] === 0xfd00 &&
    words[1] === 0x0ec2 &&
    words.slice(2, 7).every((word) => word === 0) &&
    words[7] === 0x254
  )
    ssrfBlocked();
  // fe80::/10 link-local and ff00::/8 multicast are never a relay destination.
  if ((words[0] & 0xffc0) === 0xfe80 || (words[0] & 0xff00) === 0xff00) ssrfBlocked();
  const embedded: Array<[number, number, number, number]> = [];
  const mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  const compatible = words.slice(0, 6).every((word) => word === 0);
  if (mapped) embedded.push(wordPairToIpv4(words[6], words[7]));
  else if (compatible) {
    // ::1 is loopback. Do not treat it as the IPv4-compatible address 0.0.0.1.
    if (words[6] === 0 && words[7] === 1) {
      if (privateBlocked) ssrfBlocked();
    } else if (words[6] !== 0 || words[7] !== 0) embedded.push(wordPairToIpv4(words[6], words[7]));
  }
  if (words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every((word) => word === 0))
    embedded.push(wordPairToIpv4(words[6], words[7]));
  if (words[0] === 0x64 && words[1] === 0xff9b && words[2] === 0x0001) {
    // RFC 6052 /48 embeds IPv4 around the u byte. A non-zero u byte is not a relay target.
    if (words[4] >> 8 !== 0) ssrfBlocked();
    embedded.push([words[3] >> 8, words[3] & 255, words[4] & 255, words[5] >> 8]);
  }
  if (words[0] === 0x2002) embedded.push(wordPairToIpv4(words[1], words[2]));
  if (words[0] === 0x2001 && words[1] === 0) {
    embedded.push(wordPairToIpv4(words[2], words[3]));
    embedded.push(wordPairToIpv4(words[6] ^ 0xffff, words[7] ^ 0xffff));
  }
  for (const ip of embedded) if (ipv4Disallowed(ip, privateBlocked)) ssrfBlocked();
  if (privateBlocked && (words[0] & 0xfe00) === 0xfc00) ssrfBlocked();
}
function assertIpv4Allowed(octets: [number, number, number, number], privateBlocked: boolean): void {
  if (ipv4Disallowed(octets, privateBlocked)) ssrfBlocked();
}
function rawAuthorityHost(value: string): string | undefined {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(value.trim());
  if (!match || match[1].includes('@')) return undefined;
  let authority = match[1];
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    return end > 1 ? normalizeHost(authority.slice(1, end)) : undefined;
  }
  const colon = authority.lastIndexOf(':');
  if (colon > 0 && /^\d+$/.test(authority.slice(colon + 1))) authority = authority.slice(0, colon);
  return normalizeHost(authority);
}
/** Reject an IP address that must not be used as a relay destination. */
export function validateIpAddress(ip: string, options: RelayEndpointPolicy = {}): void {
  const privateBlocked = options.allowPrivateRelay !== true;
  const host = normalizeHost(ip.trim());
  if (!host) ssrfBlocked();
  if (host.includes(':')) {
    const words = parseIpv6Words(host);
    if (!words) ssrfBlocked();
    assertIpv6Allowed(words, privateBlocked);
    return;
  }
  const decoded = decodeInetAton(host);
  if (!decoded || !partsLookNumeric(host)) ssrfBlocked();
  assertIpv4Allowed(decoded, privateBlocked);
}
/** Validate literal endpoints before using an untrusted invite as a network destination. */
export function validateRelayEndpointUrl(value: string, options: RelayEndpointPolicy = {}): void {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    ssrfBlocked();
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol) || u.username || u.password)
    ssrfBlocked();
  const host = normalizeHost(u.hostname);
  if (!host || host === 'metadata.google.internal' || host === 'metadata.goog') ssrfBlocked();
  // Private and loopback destinations stay blocked unless the caller opts in.
  const privateBlocked = options.allowPrivateRelay !== true;
  const raw = rawAuthorityHost(value);
  if (raw && raw !== host && (isNonCanonicalIpv4(raw) || partsLookNumeric(raw))) {
    const decoded = decodeInetAton(raw);
    if (!decoded || ipv4Disallowed(decoded, privateBlocked)) ssrfBlocked();
  }
  if (host.includes(':')) {
    const words = parseIpv6Words(host);
    if (!words) ssrfBlocked();
    assertIpv6Allowed(words, privateBlocked);
    return;
  }
  if (partsLookNumeric(host)) {
    const decoded = decodeInetAton(host);
    if (!decoded) ssrfBlocked();
    assertIpv4Allowed(decoded, privateBlocked);
    return;
  }
  if (
    privateBlocked &&
    (host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      host.endsWith('.internal'))
  )
    ssrfBlocked();
}
function resolveAgentKey(options: CreateAgentCardOptions, agentKey?: KeyPair): KeyPair | undefined {
  if (
    agentKey &&
    options.agentKey &&
    (agentKey.did !== options.agentKey.did || agentKey.privateKey !== options.agentKey.privateKey)
  )
    throw new Error('AGENT_DELEGATION_REQUIRED');
  return agentKey ?? options.agentKey;
}
export function createSignedAgentCard(
  options: CreateAgentCardOptions,
  owner: KeyPair,
  agentKey?: KeyPair,
): SignedAgentCard {
  const resolvedAgentKey = resolveAgentKey(options, agentKey);
  const signedAt = new Date().toISOString();
  const expiresAt =
    options.expiresAt ?? new Date(Date.parse(signedAt) + DEFAULT_AGENT_CARD_EXPIRY_MS).toISOString();
  if (options.agentDid !== owner.did) {
    if (!resolvedAgentKey || resolvedAgentKey.did !== options.agentDid)
      throw new Error('AGENT_DELEGATION_REQUIRED');
  } else if (resolvedAgentKey && resolvedAgentKey.did !== owner.did) {
    throw new Error('AGENT_DELEGATION_REQUIRED');
  }
  const delegationFields = {
    ownerDid: owner.did,
    agentDid: options.agentDid,
    relayEndpoint: options.relayEndpoint,
    expiresAt,
  };
  const agentDelegation =
    options.agentDid === owner.did
      ? undefined
      : signPayload(agentCardDelegationStatement(delegationFields), resolvedAgentKey!, signedAt)
          .signature;
  if (!validOpenPolicy(options.openPolicy)) throw new Error('INVALID_AGENT_CARD');
  const card = signPayload(
    {
      type: 'AgentCard' as const,
      version: options.version ?? '0.2.0',
      description: options.description ?? 'Sealbridge worker',
      costModes: options.costModes ?? (['worker_byok'] as BudgetSpec['costBearer'][]),
      name: options.name,
      skills: options.skills,
      ...(options.protocolVersions !== undefined ? { protocolVersions: [...options.protocolVersions] } : {}),
      ...(options.accessMode ? { accessMode: options.accessMode } : {}),
      ...(options.openPolicy !== undefined ? { openPolicy: { ...options.openPolicy } } : {}),
      ...delegationFields,
      ...(agentDelegation ? { agentDelegation } : {}),
    },
    owner,
    signedAt,
  );
  if (!verifySignedAgentCard(card)) throw new Error('INVALID_AGENT_CARD');
  return card;
}
function validAgentCardExpiry(expiresAt: string, signedAt: string, now: number): boolean {
  const expires = Date.parse(expiresAt);
  const signed = Date.parse(signedAt);
  return (
    typeof expiresAt === 'string' &&
    typeof signedAt === 'string' &&
    Number.isFinite(expires) &&
    Number.isFinite(signed) &&
    expires > signed &&
    expires > now &&
    expires - signed <= MAX_AGENT_CARD_EXPIRY_MS
  );
}
export function verifySignedAgentCard(card: SignedAgentCard, now = Date.now()): boolean {
  try {
    const p = card.payload;
    relayUrl(p.relayEndpoint);
    resolveDid(p.agentDid);
    resolveDid(p.ownerDid);
    if (!validAgentCardExpiry(p.expiresAt, card.signature.signedAt, now)) return false;
    if (p.agentDid === p.ownerDid) {
      if (p.agentDelegation !== undefined) return false;
    } else if (
      !p.agentDelegation ||
      !verifySignature(
        agentCardDelegationStatement({
          ownerDid: p.ownerDid,
          agentDid: p.agentDid,
          relayEndpoint: p.relayEndpoint,
          expiresAt: p.expiresAt,
        }),
        p.agentDelegation,
        p.agentDid,
      ) ||
      !(Date.parse(p.agentDelegation.signedAt) < Date.parse(p.expiresAt))
    )
      return false;
    return (
      verifySigned(card, p.ownerDid) &&
      p.type === 'AgentCard' &&
      validProtocolVersions(p.protocolVersions) &&
      (p.accessMode === undefined || p.accessMode === 'invite-only' || p.accessMode === 'open') &&
      validOpenPolicy(p.openPolicy) &&
      typeof p.name === 'string' &&
      !!p.name &&
      typeof p.description === 'string' &&
      typeof p.version === 'string' &&
      Array.isArray(p.skills) &&
      p.skills.every((s) => typeof s.id === 'string' && !!s.id && typeof s.name === 'string' &&
        (s.taskTypes === undefined || (Array.isArray(s.taskTypes) && s.taskTypes.every((t) => typeof t === 'string' && !!t)))) &&
      new Set(p.skills.map((s) => s.id)).size === p.skills.length &&
      Array.isArray(p.costModes) &&
      p.costModes.length > 0 &&
      p.costModes.every((m) =>
        ['worker_byok', 'bilateral_quota', 'external_settlement_plugin'].includes(m),
      )
    );
  } catch {
    return false;
  }
}
/** Select a verified card independently of directory order. Exact agent DIDs win. */
export function findDiscoveredAgentCard(
  rawCards: unknown,
  targetDid: string,
  now = Date.now(),
): SignedAgentCard | undefined {
  if (!Array.isArray(rawCards)) return undefined;
  const valid = rawCards.filter((card): card is SignedAgentCard => verifySignedAgentCard(card, now));
  const exact = valid.filter((card) => card.payload.agentDid === targetDid);
  const matches = exact.length ? exact : valid.filter((card) => card.payload.ownerDid === targetDid);
  const candidateAgents = new Set(matches.map((card) => card.payload.agentDid));
  const owners = new Map<string, string>();
  for (const card of valid) {
    const { agentDid, ownerDid } = card.payload;
    if (!candidateAgents.has(agentDid)) continue;
    if (owners.has(agentDid) && owners.get(agentDid) !== ownerDid)
      throw new Error('AMBIGUOUS_AGENT_CARD_OWNER');
    owners.set(agentDid, ownerDid);
  }
  matches.sort((a, b) => {
    const signed = Date.parse(b.signature.signedAt) - Date.parse(a.signature.signedAt);
    if (signed) return signed;
    // Equal timestamps also need a stable tie-breaker, including different agents
    // reached through the same owner alias. Avoid locale-dependent ordering.
    const left = canonicalize(a), right = canonicalize(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return matches[0];
}
export function toA2AAgentCard(card: SignedAgentCard) {
  if (!verifySignedAgentCard(card)) throw new Error('INVALID_AGENT_CARD');
  const p = card.payload;
  return {
    name: p.name,
    description: p.description,
    url: p.relayEndpoint,
    version: p.version,
    protocolVersion: '0.3.0',
    capabilities: { streaming: true },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: p.skills.map((s) => ({ ...s, description: s.description ?? s.name, tags: ['acp'] })),
    ownerDid: p.ownerDid,
    agentDid: p.agentDid,
    relayEndpoint: p.relayEndpoint,
    expiresAt: p.expiresAt,
    costModes: p.costModes,
    signedAgentCard: card,
  };
}
export interface Invite {
  type: 'AgentInvite';
  ownerDid: string;
  agentDid: string;
  relayUrl: string;
  agentCard: SignedAgentCard;
  issuedAt: string;
  expiresAt: string;
}
export function createInviteToken(
  options: {
    agentCard: SignedAgentCard;
    expiresInSeconds?: number;
    issuedAt?: string;
    format?: 'acp-invite' | 'acp';
  },
  owner: KeyPair,
): string {
  if (!verifySignedAgentCard(options.agentCard) || options.agentCard.payload.ownerDid !== owner.did)
    throw new Error('INVALID_AGENT_CARD');
  const issuedAt = options.issuedAt ?? new Date().toISOString(),
    ttl = options.expiresInSeconds ?? 3600;
  if (
    !Number.isFinite(Date.parse(issuedAt)) ||
    !Number.isSafeInteger(ttl) ||
    ttl < 1 ||
    ttl > 2592000
  )
    throw new Error('INVALID_INVITE_EXPIRY');
  const p = options.agentCard.payload;
  const token = Buffer.from(
    JSON.stringify(
      signPayload<Invite>(
        {
          type: 'AgentInvite',
          ownerDid: owner.did,
          agentDid: p.agentDid,
          relayUrl: p.relayEndpoint,
          agentCard: options.agentCard,
          issuedAt,
          expiresAt: new Date(Date.parse(issuedAt) + ttl * 1000).toISOString(),
        },
        owner,
      ),
    ),
  ).toString('base64url');
  return options.format === 'acp' ? 'acp://invite?token=' + token : 'acp-invite:' + token;
}
/** Extract invitation material locally; HTTPS links are never fetched. */
export function inviteTokenFromUri(uri: string): string {
  if (uri.startsWith('acp-invite:')) return uri;
  let url: URL;
  try { url = new URL(uri); } catch { throw new Error('INVALID_OR_EXPIRED_INVITE'); }
  if (url.protocol === 'https:') {
    if (!url.hash.startsWith('#acp-invite:') || url.hash === '#acp-invite:')
      throw new Error('INVITE_LINK_TOKEN_REQUIRED: ask the sender for the complete link including #acp-invite:...');
    if (url.username || url.password || url.search || !/^#acp-invite:[A-Za-z0-9_-]+$/.test(url.hash))
      throw new Error('INVALID_INVITE_LINK');
    return url.hash.slice(1);
  }
  if (url.protocol === 'acp:' && url.hostname === 'invite' && url.searchParams.getAll('token').length === 1)
    return 'acp-invite:' + url.searchParams.get('token');
  throw new Error('INVALID_OR_EXPIRED_INVITE');
}
export function isInviteTarget(value: string): boolean {
  return value.startsWith('acp') || value.startsWith('https:');
}
export function parseAndVerifyInviteToken(
  uri: string,
  now = Date.now(),
  options: {
    allowPrivateRelay?: boolean;
    /** Verify historical invites for revocation lookup without requiring current validity. */
    allowExpired?: boolean;
  } = {},
): Invite {
  try {
    const token = inviteTokenFromUri(uri).slice(11);
    if (!/^[\w-]+$/.test(token) || token.length > 65536) throw new Error();
    const signed = JSON.parse(Buffer.from(token, 'base64url').toString()) as Signed<Invite>,
      p = signed.payload;
    if (
      !verifySigned(signed, p.ownerDid) ||
      p.type !== 'AgentInvite' ||
      !verifySignedAgentCard(p.agentCard, Math.min(now, Date.parse(p.issuedAt))) ||
      p.agentCard.payload.ownerDid !== p.ownerDid ||
      p.agentCard.payload.agentDid !== p.agentDid ||
      p.agentCard.payload.relayEndpoint !== p.relayUrl ||
      !Number.isFinite(Date.parse(p.issuedAt)) ||
      !Number.isFinite(Date.parse(p.expiresAt)) ||
      Date.parse(p.issuedAt) > now + DEFAULT_CLOCK_SKEW_MS ||
      Date.parse(p.expiresAt) <= Date.parse(p.issuedAt)
    )
      throw new Error();
    if (!options.allowExpired &&
        (Date.parse(p.expiresAt) <= now || Date.parse(p.agentCard.payload.expiresAt) <= now))
      throw new Error('INVITE_EXPIRED');
    validateRelayEndpointUrl(p.relayUrl, options);
    return p;
  } catch (error) {
    if (error instanceof Error && (['SSRF_BLOCKED_RELAY_URL', 'INVITE_EXPIRED', 'INVALID_INVITE_LINK'].includes(error.message) || error.message.startsWith('INVITE_LINK_TOKEN_REQUIRED:'))) throw error;
    throw new Error('INVALID_OR_EXPIRED_INVITE');
  }
}

/** Resolve current signed cards before filtering, so stale advertisements cannot reopen access. */
export function discoverAgentCards(rawCards: unknown, query: {
  did?: string; skillId?: string; taskType?: string; accessMode?: 'invite-only' | 'open';
} = {}, now = Date.now()): SignedAgentCard[] {
  if (!Array.isArray(rawCards)) return [];
  const valid = rawCards.filter((card): card is SignedAgentCard => verifySignedAgentCard(card, now));
  const targets = query.did ? [query.did] : [...new Set(valid.map((c) => c.payload.agentDid))].sort();
  return targets.map((did) => findDiscoveredAgentCard(valid, did, now)).filter((c): c is SignedAgentCard => {
    if (!c || (query.accessMode && c.payload.accessMode !== query.accessMode)) return false;
    return (!query.skillId && !query.taskType) || c.payload.skills.some((s) =>
      (!query.skillId || s.id === query.skillId) && (!query.taskType || s.taskTypes?.includes(query.taskType)));
  });
}
