// SPDX-License-Identifier: Apache-2.0
import type { Json } from '@acp/core';

/**
 * MCP tool catalog for {@link AcpMcpServer}.
 * Every property description, annotation, and output schema is part of the
 * contract clients and tool-quality reviewers read from `tools/list`.
 */

function described(description: string, schema: Json): Json {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return { description };
  return { ...(schema as { [key: string]: Json }), description };
}

function objectSchema(
  description: string,
  properties: { [key: string]: Json },
  required?: string[],
): Json {
  const schema: { [key: string]: Json } = {
    type: 'object',
    additionalProperties: false,
    description,
    properties,
  };
  if (required && required.length > 0) schema.required = required;
  return schema;
}

function jsonValue(description: string): Json {
  return {
    description,
    type: ['object', 'array', 'string', 'number', 'boolean', 'null'],
  };
}

const signatureSchema = objectSchema(
  'Ed25519 signature over the RFC 8785 JCS payload.',
  {
    signerDid: described('did:key that produced this signature.', { type: 'string' }),
    canonicalization: described('Canonicalization used before signing. Sealbridge signatures use RFC8785-JCS.', {
      type: 'string',
      enum: ['RFC8785-JCS'],
    }),
    payloadDigest: described('SHA-256 digest of the JCS payload that was signed.', { type: 'string' }),
    signedAt: described('ISO-8601 timestamp when the signature was produced.', { type: 'string' }),
    signature: described('Base64url-encoded Ed25519 signature bytes.', { type: 'string' }),
  },
  ['signerDid', 'canonicalization', 'payloadDigest', 'signedAt', 'signature'],
);

const auditBodySchema = objectSchema(
  'Audit entry body. seq starts at 0 and prevEntryHash chains to the previous entry, or null for the first entry.',
  {
    taskId: described('Task id shared by every entry in this bundle.', { type: 'string' }),
    seq: described('Zero-based position of this entry in the bundle.', {
      type: 'integer',
      minimum: 0,
    }),
    prevEntryHash: described('Hash of the previous entry, or null on the first entry.', {
      type: ['string', 'null'],
    }),
    actorDid: described('did:key of the party that appended this entry.', { type: 'string' }),
    receiverDid: described('did:key of the counterparty that acknowledged this entry.', {
      type: 'string',
    }),
    eventType: described('Protocol event name, such as PROPOSE, ACCEPT, PROGRESS, DELIVER, or SETTLED.', {
      type: 'string',
    }),
    payload: jsonValue('JSON payload for this event. Shape depends on eventType.'),
  },
  ['taskId', 'seq', 'prevEntryHash', 'actorDid', 'receiverDid', 'eventType', 'payload'],
);

const ackPayloadSchema = objectSchema(
  'Acknowledgement bound to one audit entry hash.',
  {
    type: described('Always AckReceipt. This object acknowledges one audit entry hash.', {
      type: 'string',
      enum: ['AckReceipt'],
    }),
    taskId: described('Task id of the acknowledged entry.', { type: 'string' }),
    entryHash: described('Hash of the audit entry this acknowledgement covers.', { type: 'string' }),
    actorDid: described('did:key of the party that appended the entry.', { type: 'string' }),
    receiverDid: described('did:key of the party that acknowledged the entry.', { type: 'string' }),
  },
  ['type', 'taskId', 'entryHash', 'actorDid', 'receiverDid'],
);

const auditEntrySchema = objectSchema(
  'One countersigned audit entry. The hash chain and both signatures must verify.',
  {
    body: auditBodySchema,
    entryHash: described('JCS SHA-256 of body. The next entry stores this value as prevEntryHash.', {
      type: 'string',
    }),
    actorSignature: signatureSchema,
    counterSignature: objectSchema(
      'Receiver acknowledgement. payload is the AckReceipt and signature is the receiver Ed25519 signature.',
      {
        payload: ackPayloadSchema,
        signature: signatureSchema,
      },
      ['payload', 'signature'],
    ),
  },
  ['body', 'entryHash', 'actorSignature', 'counterSignature'],
);

const checkpointPayloadSchema = objectSchema(
  'Bilateral checkpoint covering the whole entry list.',
  {
    type: described('Always AuditCheckpoint. This payload seals the full entry list.', {
      type: 'string',
      enum: ['AuditCheckpoint'],
    }),
    taskId: described('Task id bound into the checkpoint.', { type: 'string' }),
    count: described('Number of audit entries. Must equal entries.length.', {
      type: 'integer',
      minimum: 0,
    }),
    head: described('Hash of the last entry, or null when entries is empty.', {
      type: ['string', 'null'],
    }),
    actors: described('Ordered pair of distinct actor DIDs that countersigned the log.', {
      type: 'array',
      minItems: 2,
      maxItems: 2,
      items: described('One actor did:key. Order must match the checkpoint.', { type: 'string' }),
    }),
  },
  ['type', 'taskId', 'count', 'head', 'actors'],
);

const signedCheckpointSchema = objectSchema(
  'Checkpoint signed by one actor.',
  {
    payload: checkpointPayloadSchema,
    signature: signatureSchema,
  },
  ['payload', 'signature'],
);

const bundleSchema = objectSchema(
  'Bilateral AuditBundle to verify offline. The server checks signatures and the hash chain locally and does not contact a relay.',
  {
    entries: described('Ordered audit entries. An empty list cannot form a valid checkpoint.', {
      type: 'array',
      items: auditEntrySchema,
    }),
    checkpoint: objectSchema(
      'Bilateral seal. actor signs the checkpoint, and receiver signs that signed checkpoint.',
      {
        actor: signedCheckpointSchema,
        receiver: objectSchema(
          'Counter-signature over the actor signed checkpoint. payload equals checkpoint.actor.',
          {
            payload: signedCheckpointSchema,
            signature: signatureSchema,
          },
          ['payload', 'signature'],
        ),
      },
      ['actor', 'receiver'],
    ),
  },
  ['entries', 'checkpoint'],
);

const taskTimeoutProperties = {
  executionTimeoutMs: { type: 'integer', minimum: 1000, maximum: 2147483647,
    description: 'Execution wall-clock ceiling in milliseconds; whole seconds are proposed as the contract budget. Default budget: 60000 ms.' },
  taskTimeoutMs: { type: 'integer', minimum: 1, maximum: 2147483647,
    description: 'Overall task timeout including approval and settlement. Default 600000 ms.' },
  waitTimeoutMs: { type: 'integer', minimum: 1, maximum: 2147483647,
    description: 'Peer or owner approval wait phase timeout. Default 600000 ms.' },
  connectTimeoutMs: { type: 'integer', minimum: 1, maximum: 2147483647,
    description: 'Relay request/connect timeout. Default 45000 ms.' },
  transportIdleTimeoutMs: { type: 'integer', minimum: 1, maximum: 2147483647,
    description: 'Authenticated peer idle limit during execution. Default 90000 ms.' },
  heartbeatIntervalMs: { type: 'integer', minimum: 1, maximum: 2147483647,
    description: 'Expected worker heartbeat cadence for timeout compatibility checks. Default 15000 ms. Configure the worker separately.' },
} as const;
const budgetSchema = objectSchema(
  'Optional task quota. Omitted fields keep the manifest defaults: costBearer worker_byok, maxInputTokens 50000, maxOutputTokens 10000, maxToolInvocations 10, maxWallClockSeconds 60, and onOverrun hard_stop.',
  {
    costBearer: described(
      'Who accounts for model cost. Default worker_byok. Raw provider keys are never sent to the worker.',
      {
        type: 'string',
        enum: ['worker_byok', 'bilateral_quota', 'external_settlement_plugin'],
        default: 'worker_byok',
      },
    ),
    maxInputTokens: described('Maximum input tokens charged to the task before onOverrun. Default 50000.', {
      type: 'integer',
      minimum: 0,
      maximum: 100000000,
      default: 50000,
    }),
    maxOutputTokens: described('Maximum output tokens charged to the task before onOverrun. Default 10000.', {
      type: 'integer',
      minimum: 0,
      maximum: 100000000,
      default: 10000,
    }),
    maxToolInvocations: described('Maximum tool calls the worker may report before onOverrun. Default 10.', {
      type: 'integer',
      minimum: 0,
      maximum: 100000,
      default: 10,
    }),
    maxWallClockSeconds: described('Maximum wall-clock seconds for the task before onOverrun. Default 60.', {
      type: 'integer',
      minimum: 1,
      maximum: 604800,
      default: 60,
    }),
    onOverrun: described(
      'What the worker does when a quota is exceeded. Default hard_stop. request_hitl_amendment asks for a budget change instead of stopping.',
      { type: 'string', enum: ['hard_stop', 'request_hitl_amendment'], default: 'hard_stop' },
    ),
    settlementExtension: described(
      'Optional plugin metadata for off-protocol settlement. Omit it for ordinary worker_byok tasks. Keys are defined by that plugin.',
      { type: 'object', additionalProperties: true },
    ),
  },
);

const anchorSchema = objectSchema(
  'Legacy trust anchor. Setting taskId, actors, or head checks log truncation. Do not contradict the same fact with expectedFinalState, expectedLastEntryHash, or expectedEntryCount.',
  {
    taskId: described('Expected checkpoint taskId. A different id returns valid false.', {
      type: 'string',
    }),
    actors: described('Expected ordered pair of distinct actor DIDs. Order must match the checkpoint.', {
      type: 'array',
      minItems: 2,
      maxItems: 2,
      items: described('One actor did:key in checkpoint order.', { type: 'string' }),
    }),
    head: described('Expected checkpoint head, the hash of the last entry. A shorter prefix fails this pin.', {
      type: 'string',
    }),
  },
);

const workerTargetSchema = objectSchema(
  'One remote worker. workerDid is always required. inviteToken authenticates that worker, and relayUrl overrides the call-level relay for this worker only.',
  {
    workerDid: described(
      'did:key of this worker. Required even when inviteToken is set. The allowlist checks workerDid only when inviteToken is omitted; an invite matches on its agentDid or ownerDid.',
      { type: 'string' },
    ),
    inviteToken: described(
      'Optional acp-invite or acp://invite token for this worker. When set, its embedded relay URL is allowlisted before dialing and its agentDid or ownerDid satisfies allowedWorkerDids.',
      { type: 'string' },
    ),
    relayUrl: described(
      'Optional relay URL for this worker. Normalized to origin plus pathname with no trailing slash and checked against allowedRelayUrls. Falls back to the call-level relayUrl, then the server relay.',
      { type: 'string' },
    ),
  },
  ['workerDid'],
);

const taskInputSchema = jsonValue(
  'JSON payload transmitted to the worker. Any JSON value is accepted, and an omitted value is sent as null. Do not include secrets, API keys, or private keys.',
);

const taskOutputSchema = described(
  'JSON Schema object the worker deliverable must satisfy. Omit it to accept any JSON value. This is the task contract, separate from this tool result schema.',
  { type: 'object', additionalProperties: true },
);

const taskTitleSchema = described(
  'Task title copied into the signed manifest. It must be 1 to 200 characters or the call fails with SCHEMA_VIOLATION.',
  { type: 'string', minLength: 1, maxLength: 200 },
);

const taskDescriptionSchema = described(
  'Task detail copied into the manifest and shown to the worker. It must be 1 to 32768 characters. For single-worker delegation, an omitted value defaults to the task title; multi-worker delegation requires a description.',
  { type: 'string', minLength: 1, maxLength: 32768 },
);

const isolationSchema = described(
  'Lowest sandbox the worker must attest. Omit it to keep subprocess_restricted, which is not kernel network isolation. Set oci_container for untrusted code; that level requires a network-none container and execution attestation.',
  {
    type: 'string',
    enum: ['subprocess_restricted', 'oci_container'],
    default: 'subprocess_restricted',
  },
);

const delegateRelaySchema = described(
  'Optional relay dial target, subject to the configured relay policy. Without a pin or invite, defaults to https://relay.sealbridge.dev. Normalized to origin plus pathname with no trailing slash and rejected with MCP_RELAY_NOT_ALLOWED when it is outside allowedRelayUrls.',
  { type: 'string' },
);

const inviteTokenSchema = described(
  'acp-invite token, acp://invite URI, or complete HTTPS invite link. When set, it identifies the worker instead of workerDid: allowedWorkerDids matches the invite agentDid or ownerDid, and the embedded relay URL must pass the relay allowlist. The dial target is relayUrl if set, otherwise an explicit server relay, otherwise the invite relay. Bare DID delegation defaults to https://relay.sealbridge.dev.',
  { type: 'string' },
);

const workerDidSchema = described(
  'Worker did:key used only when inviteToken is omitted. It must appear exactly in allowedWorkerDids when that allowlist is set, and relayUrl or the server relay selects the relay, otherwise https://relay.sealbridge.dev is used.',
  { type: 'string' },
);

const auditSummarySchema = objectSchema(
  'Local verification of the bilateral audit bundle returned with the deliverable.',
  {
    valid: described('True when the bundle signatures and hash chain verify.', { type: 'boolean' }),
    status: described('VALID or INVALID from the audit verifier.', {
      type: 'string',
      enum: ['VALID', 'INVALID'],
    }),
    count: described('Number of audit entries in the bundle.', { type: 'integer', minimum: 0 }),
    head: described('Checkpoint head hash, or null when the bundle has no entries.', {
      type: ['string', 'null'],
    }),
    taskId: described('Task id of this worker session.', { type: 'string' }),
  },
  ['valid', 'status', 'count', 'head', 'taskId'],
);

const verificationReportSchema = objectSchema(
  'Offline audit verification report. An invalid bundle is this report with valid false, not a tool error.',
  {
    valid: described('True only when signatures, the hash chain, and any supplied anchor all match.', {
      type: 'boolean',
    }),
    status: described('VALID or INVALID. INVALID is still a successful tool result.', {
      type: 'string',
      enum: ['VALID', 'INVALID'],
    }),
    statusLabel: described(
      'VALID, INVALID, or VALID (no trust anchor: truncation not checked) when no anchor or expected tail field was supplied.',
      { type: 'string' },
    ),
    trustAnchorVerified: described('True when a supplied anchor or expected tail field matched the checkpoint.', {
      type: 'boolean',
    }),
    truncationChecked: described(
      'True when an anchor or expected tail field was supplied, including when that check failed.',
      { type: 'boolean' },
    ),
    reason: described('Present when valid is false. Explains the first check that failed.', {
      type: 'string',
    }),
  },
  ['valid', 'status', 'statusLabel', 'trustAnchorVerified', 'truncationChecked'],
);

const revocationPayloadSchema = objectSchema(
  'RevocationNotice body signed by the server owner.',
  {
    type: described('Always RevocationNotice. This body is the signed revocation record.', {
      type: 'string',
      enum: ['RevocationNotice'],
    }),
    revocationId: described('Unique id of this notice. A repeat revoke mints a new id.', {
      type: 'string',
    }),
    issuerDid: described('did:key of the server owner that signed the notice.', { type: 'string' }),
    targetType: described('invite revokes an invite digest. capability revokes a capability id.', {
      type: 'string',
      enum: ['invite', 'capability'],
    }),
    targetId: described(
      'Invite revocation digest or capability id. For invites this is not the raw acp-invite string.',
      { type: 'string' },
    ),
    reason: described('Human-readable reason stored on the notice.', { type: 'string' }),
    revokedAt: described('ISO-8601 time when the notice was signed.', { type: 'string' }),
  },
  ['type', 'revocationId', 'issuerDid', 'targetType', 'targetId', 'reason', 'revokedAt'],
);

const signedRevocationSchema = objectSchema(
  'Signed RevocationNotice recorded in this server in-memory registry.',
  {
    payload: revocationPayloadSchema,
    signature: signatureSchema,
  },
  ['payload', 'signature'],
);

const skillSchema = objectSchema(
  'One skill advertised on a signed agent card. description is omitted when the card has none.',
  {
    id: described('Stable skill id from the agent card.', { type: 'string' }),
    name: described('Human-readable skill name.', { type: 'string' }),
    description: described('Skill detail from the card, present only when the publisher set one.', {
      type: 'string',
    }),
    taskTypes: described('Task types advertised for this skill.', { type: 'array', items: { type: 'string' } }),
    inputSchema: jsonValue('JSON input schema advertised for this skill.'),
    outputSchema: jsonValue('JSON output schema advertised for this skill.'),
  },
  ['id', 'name'],
);

const discoveredWorkerSchema = objectSchema(
  'Public projection of one signed agent card. The server has already verified the signature.',
  {
    name: described('Display name from the agent card.', { type: 'string' }),
    description: described('Card description published by the worker owner.', { type: 'string' }),
    ownerDid: described('Owner did:key that signed the card.', { type: 'string' }),
    agentDid: described('Agent did:key that will receive delegated tasks.', { type: 'string' }),
    workerDid: described('Agent DID to pass unchanged to acp_delegate_task.', { type: 'string' }),
    relayUrl: described('Queried relay to pass unchanged to acp_delegate_task; null for an injected transport without a URL.', { type: ['string', 'null'] }),
    accessMode: described('Effective access mode; legacy cards without a mode are invite-only.', { type: 'string', enum: ['open', 'invite-only'] }),
    acceptance: described('The worker independently decides whether to accept each task.', { type: 'string', const: 'worker_decides' }),
    openPolicy: described('Signed open policy when the publisher includes one.', { type: 'object', additionalProperties: { type: 'integer', minimum: 1 } }),
    signedAgentCard: described('Complete signed card as published, including the original payload and signature.', { type: 'object', additionalProperties: true }),
    relayEndpoint: described('Relay URL embedded in the card.', { type: 'string' }),
    expiresAt: described('ISO-8601 expiry after which the card must be rejected.', { type: 'string' }),
    version: described('Card version string published by the worker.', { type: 'string' }),
    costModes: described('Cost bearers the worker advertises, such as worker_byok.', {
      type: 'array',
      items: described('One advertised costBearer value.', { type: 'string' }),
    }),
    skills: described('Skills advertised on the card.', { type: 'array', items: skillSchema }),
    signerDid: described('did:key that signed the card. Matches ownerDid for a valid card.', {
      type: 'string',
    }),
    signedAt: described('ISO-8601 time when the card was signed.', { type: 'string' }),
    signature: signatureSchema,
    agentDelegation: described(
      'Present only when agentDid differs from ownerDid. Signature by the agent key over the owner, agent, relay, and expiry.',
      signatureSchema,
    ),
  },
  [
    'name',
    'description',
    'ownerDid',
    'agentDid',
    'relayEndpoint',
    'workerDid',
    'relayUrl',
    'accessMode',
    'acceptance',
    'signedAgentCard',
    'expiresAt',
    'version',
    'costModes',
    'skills',
    'signerDid',
    'signedAt',
    'signature',
  ],
);

function tool(options: {
  name: string;
  title: string;
  description: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
  inputSchema: Json;
  outputSchema: Json;
}): Json {
  return {
    name: options.name,
    title: options.title,
    description: options.description,
    inputSchema: options.inputSchema,
    outputSchema: options.outputSchema,
    annotations: {
      title: options.title,
      readOnlyHint: options.readOnlyHint,
      destructiveHint: options.destructiveHint,
      idempotentHint: options.idempotentHint,
      openWorldHint: options.openWorldHint,
    },
  };
}

/** Tools returned by `tools/list`, in catalog order. */
export const mcpTools: Json = [
  tool({
    name: 'acp_delegate_task',
    title: 'Delegate one task',
    description:
      'Delegate one JSON task to a single remote Sealbridge worker and return the verified deliverable, taskId, status, and audit summary. Use acp_delegate_multi for race or quorum, and acp_verify_audit_bundle to check a bundle you already hold. Pass inviteToken or workerDid, with optional relayUrl: an invite matches allowedWorkerDids on agentDid or ownerDid and embeds its relay, while a bare DID must be listed exactly when that allowlist is configured. The server signs with its Ed25519 owner key, enforces worker and relay allowlists, and applies the configured approval policy before task input is transmitted externally over the relay. When requested, approval uses advertised MCP form elicitation or an explicit webhook/provider; unsupported hosts return APPROVAL_CHANNEL_UNAVAILABLE before task transmission; each call opens a new session and is not idempotent. Bad arguments are JSON-RPC -32602, and operational failure returns isError true with { error: CODE }; a failure may occur after input transmission, and failures after transmission do not undo the task.',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
    inputSchema: objectSchema(
      'Arguments for delegating one task to one worker.',
      {
        relayUrl: delegateRelaySchema,
        inviteToken: inviteTokenSchema,
        workerDid: workerDidSchema,
        title: taskTitleSchema,
        description: taskDescriptionSchema,
        input: taskInputSchema,
        outputSchema: taskOutputSchema,
        budget: budgetSchema,
        ...taskTimeoutProperties,
        minimumIsolationLevel: isolationSchema,
      },
      ['title'],
    ),
    outputSchema: objectSchema(
      'Success payload in structuredContent. Operational failures use isError and do not use this shape.',
      {
        taskId: described('Protocol task id of the opened session.', { type: 'string' }),
        status: described('SETTLED when the deliverable verified, or CANCELLED when the session was cancelled.', {
          type: 'string',
          enum: ['SETTLED', 'CANCELLED'],
        }),
        deliverable: jsonValue('JSON value the worker returned after verification. Null when the session was cancelled.'),
        auditBundle: auditSummarySchema,
      },
      ['taskId', 'status', 'deliverable', 'auditBundle'],
    ),
  }),
  tool({
    name: 'acp_delegate_multi',
    title: 'Delegate to multiple workers',
    description:
      'Delegate one JSON task to several remote Sealbridge workers and return the winning deliverable, digest, task ids, and per-worker audit summaries; use acp_delegate_task for one worker. mode race keeps the first verified result and cancels the rest; quorum requires quorumSize matching digests (default floor of worker count over 2, plus 1) or returns QUORUM_NOT_REACHED. Each workers item needs workerDid and may include inviteToken or relayUrl; allowlists, signing, and the configured approval policy apply before input is transmitted externally over the relay. When requested, host form approval reviews each recipient with total fan-out disclosed; use a host with elicitation or an explicit webhook/provider. Calls are not idempotent; bad arguments are JSON-RPC -32602, and operational failures return isError true with { error: CODE } and no partial deliverable, including failures after transmission.',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
    inputSchema: objectSchema(
      'Arguments for race or quorum delegation.',
      {
        workers: described(
          'Workers that each receive the same task. At least one entry is required.',
          { type: 'array', minItems: 1, items: workerTargetSchema },
        ),
        mode: described(
          'race returns the first verified deliverable and cancels the other workers. quorum returns a deliverable only after enough workers produce the same output digest.',
          { type: 'string', enum: ['race', 'quorum'] },
        ),
        quorumSize: described(
          'Agreement count used only when mode is quorum. Omit it to use floor of the worker count over 2, plus 1. Ignored when mode is race. The call fails with QUORUM_NOT_REACHED when that many matching digests are impossible.',
          { type: 'integer', minimum: 1 },
        ),
        relayUrl: delegateRelaySchema,
        title: taskTitleSchema,
        description: taskDescriptionSchema,
        input: taskInputSchema,
        outputSchema: taskOutputSchema,
        budget: budgetSchema,
        ...taskTimeoutProperties,
        minimumIsolationLevel: isolationSchema,
      },
      ['workers', 'mode', 'title'],
    ),
    outputSchema: objectSchema(
      'Success payload in structuredContent. Quorum or transport failure is isError rather than this object.',
      {
        mode: described('race or quorum, matching the request.', {
          type: 'string',
          enum: ['race', 'quorum'],
        }),
        status: described('SETTLED when a winning verified deliverable was selected.', {
          type: 'string',
          enum: ['SETTLED'],
        }),
        deliverable: jsonValue('Winning JSON deliverable shared by the winning workers.'),
        outputDigest: described('JCS SHA-256 of the winning deliverable.', { type: 'string' }),
        taskIds: described('Task id of every worker session that was opened.', {
          type: 'array',
          items: described('Task id of one worker session opened for this delegation.', {
            type: 'string',
          }),
        }),
        winners: described('Workers whose verified output matched the winning digest.', {
          type: 'array',
          items: objectSchema(
            'One worker included in the winning set.',
            {
              workerDid: described('did:key of a winning worker.', { type: 'string' }),
              taskId: described('Task id of that worker session.', { type: 'string' }),
              outputDigest: described('JCS SHA-256 of that worker deliverable.', { type: 'string' }),
            },
            ['workerDid', 'taskId', 'outputDigest'],
          ),
        }),
        cancelled: described('Worker DIDs whose sessions were cancelled after a winner was chosen.', {
          type: 'array',
          items: described('did:key of a cancelled worker.', { type: 'string' }),
        }),
        auditBundles: described('Per-worker audit summary for every receipt the call collected.', {
          type: 'array',
          items: objectSchema(
            'Audit summary for one worker receipt.',
            {
              workerDid: described('did:key of the worker that produced this receipt.', { type: 'string' }),
              taskId: described('Task id of that worker session.', { type: 'string' }),
              outputDigest: described('JCS SHA-256 of that worker deliverable.', { type: 'string' }),
              valid: described('True when that worker audit bundle verified.', { type: 'boolean' }),
              count: described('Number of audit entries in that bundle.', {
                type: 'integer',
                minimum: 0,
              }),
              head: described('Checkpoint head of that bundle, or null when it has no entries.', {
                type: ['string', 'null'],
              }),
            },
            ['workerDid', 'taskId', 'outputDigest', 'valid', 'count', 'head'],
          ),
        }),
      },
      [
        'mode',
        'status',
        'deliverable',
        'outputDigest',
        'taskIds',
        'winners',
        'cancelled',
        'auditBundles',
      ],
    ),
  }),
  tool({
    name: 'acp_verify_audit_bundle',
    title: 'Verify an audit bundle',
    description:
      'Verify one bilateral AuditBundle locally and return valid, status, statusLabel, trustAnchorVerified, and truncationChecked. Use this for a bundle you already hold; use acp_delegate_task or acp_delegate_multi to produce one. With no anchor, expectedFinalState, expectedLastEntryHash, or expectedEntryCount, a valid chain is labeled VALID (no trust anchor: truncation not checked) and an older prefix is not ruled out. Any of those pins checks the tail: a match sets trustAnchorVerified and truncationChecked, and a truncated bundle returns valid false with status INVALID in the report rather than isError. The check is read-only, idempotent, and offline, and bad arguments are JSON-RPC -32602.',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    inputSchema: objectSchema(
      'Bundle plus optional tail pins. Supplying any pin enables truncation checks.',
      {
        bundle: bundleSchema,
        anchor: anchorSchema,
        expectedFinalState: described(
          'Event type required on the last audit entry, such as SETTLED. Setting it checks the tail, and a mismatch returns valid false.',
          { type: 'string' },
        ),
        expectedLastEntryHash: described(
          'Entry hash required on the last audit entry. It equals the checkpoint head of a complete log, and a shorter prefix fails.',
          { type: 'string' },
        ),
        expectedEntryCount: described(
          'Entry count required on the checkpoint. Setting it rejects a log whose length differs, including a truncated prefix.',
          { type: 'integer', minimum: 0 },
        ),
      },
      ['bundle'],
    ),
    outputSchema: verificationReportSchema,
  }),
  tool({
    name: 'acp_create_invite',
    title: 'Create an invite token',
    description:
      'Sign an acp-invite token for this server owner and return it for a requester to pass to acp_delegate_task. Use this to mint a shareable invite, use acp_revoke_token to invalidate one, and use acp_discover_workers to list registered workers instead of guessing a DID. relayUrl defaults to the server relay or https://relay.sealbridge.dev and is embedded in the token, name defaults to the server name or Sealbridge Worker, expiresInSeconds defaults to 3600 and must be an integer from 1 to 2592000, and agentDid defaults to the owner DID. A different agentDid is signed only when this server holds that agent key; otherwise the call fails with AGENT_DELEGATION_REQUIRED. Signing is local Ed25519 with no relay traffic, each call mints a distinct token so it is not idempotent, and bad arguments are JSON-RPC -32602 while other failures return isError true with { error: CODE }.',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
    inputSchema: objectSchema(
      'Arguments for minting one acp-invite token.',
      {
        relayUrl: described(
          'Relay URL embedded in the invite and the signed agent card. Defaults to the configured relay or https://relay.sealbridge.dev. The token does not contact this URL.',
          { type: 'string' },
        ),
        name: described(
          'Display name stored on the signed agent card inside the invite. Defaults to the server name, or Sealbridge Worker when the server has no name.',
          { type: 'string' },
        ),
        expiresInSeconds: described(
          'Invite lifetime in seconds. Defaults to 3600 when omitted. Values outside the integers 1 through 2592000 fail with INVALID_INVITE_EXPIRY.',
          { type: 'integer', minimum: 1, maximum: 2592000, default: 3600 },
        ),
        agentDid: described(
          'did:key placed on the invite. Defaults to the server owner. A different DID requires agentKey on the server and fails with AGENT_DELEGATION_REQUIRED when that key is missing.',
          { type: 'string' },
        ),
      },
      [],
    ),
    outputSchema: objectSchema(
      'Success payload in structuredContent. The token embeds the public card and relay URL, not a private key.',
      {
        inviteToken: described(
          'Signed acp-invite token to share with a requester. Pass it to acp_delegate_task as inviteToken.',
          { type: 'string' },
        ),
      },
      ['inviteToken'],
    ),
  }),
  tool({
    name: 'acp_revoke_token',
    title: 'Revoke an invite or capability',
    description:
      'Sign a RevocationNotice with this server owner key and store it in the in-memory registry, returning the signed notice. Use this to invalidate an invite or capability, use acp_inspect_revocations to read that registry, and use acp_create_invite to mint a replacement. targetType invite expects targetId to be the invite revocation digest, while targetType capability expects the capability id, and reason is required text stored on the notice. Repeating a call replaces the stored notice, so it is not idempotent, but the target remains revoked, and the notice is not sent to a worker inbox. Bad arguments are JSON-RPC -32602, and other failures return isError true with { error: CODE }.',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
    inputSchema: objectSchema(
      'Arguments for recording one local revocation.',
      {
        targetType: described(
          'invite revokes an invite whose targetId is the JCS digest of the verified invite. capability revokes a capability id. The two id spaces are not interchangeable.',
          { type: 'string', enum: ['invite', 'capability'] },
        ),
        targetId: described(
          'Identifier to revoke. For targetType invite, pass the invite revocation digest, not the raw acp-invite string. For targetType capability, pass the capability id.',
          { type: 'string' },
        ),
        reason: described('Required reason stored on the signed notice and returned by acp_inspect_revocations.', {
          type: 'string',
        }),
      },
      ['targetType', 'targetId', 'reason'],
    ),
    outputSchema: objectSchema(
      'Success payload in structuredContent. The notice is stored only in this process.',
      { notice: signedRevocationSchema },
      ['notice'],
    ),
  }),
  tool({
    name: 'acp_discover_workers',
    title: 'Discover registered workers',
    description:
      'List current signed worker cards on the server relay or https://relay.sealbridge.dev, defaulting to accessMode open. Use accessMode all for the operator view, or filter by skillId and taskType; legacy cards without a mode are invite-only. Pass a selected workerDid and relayUrl unchanged to acp_delegate_task with title and input; worker acceptance remains independent. This read-only directory fetch verifies signatures and expiry, drops invalid cards and mismatched endpoints, sends no task input, and requires no delegation approval. Explicit relay policies apply, bad arguments are JSON-RPC -32602, and operational failures return isError true with { error: CODE }.',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
    inputSchema: objectSchema(
      'Arguments for reading one relay agent directory.',
      {
        accessMode: described('Access mode to list; open is the MCP default, all includes invite-only and legacy cards.', { type: 'string', enum: ['open', 'invite-only', 'all'], default: 'open' }),
        skillId: described('Return workers advertising this exact skill identifier.', { type: 'string', minLength: 1 }),
        taskType: described('Return workers advertising this task type in a matching skill.', { type: 'string', minLength: 1 }),
        relayUrl: described(
          'Directory relay to query. Omit it to use the server relay or https://relay.sealbridge.dev. Normalized to origin plus pathname with no trailing slash and rejected with MCP_RELAY_NOT_ALLOWED when it is outside allowedRelayUrls. Private and loopback relays stay blocked unless the server was started with allowPrivateRelay.',
          { type: 'string' },
        ),
      },
    ),
    outputSchema: objectSchema(
      'Success payload in structuredContent. Invalid or expired cards are omitted; a non-array directory response raises INVALID_AGENT_CARD.',
      {
        relayUrl: described(
          'Relay URL that was queried, or null when the server relay is an in-memory transport with no URL.',
          { type: ['string', 'null'] },
        ),
        count: described('Number of verified cards returned in workers.', {
          type: 'integer',
          minimum: 0,
        }),
        workers: described('Verified agent cards. Delegation still enforces allowedWorkerDids separately.', {
          type: 'array',
          items: discoveredWorkerSchema,
        }),
      },
      ['relayUrl', 'count', 'workers'],
    ),
  }),
  tool({
    name: 'acp_inspect_revocations',
    title: 'Inspect revocation notices',
    description:
      'List RevocationNotices in this server process and return the matches, a count, and whether one target is revoked. Use this to read local revocation state, use acp_revoke_token to add a notice, and do not treat the result as proof that a remote worker has ingested it. Omit both filters to export every notice, pass targetType alone to filter by invite or capability, or pass both targetType and targetId to include revoked. targetId is the same identifier acp_revoke_token stores, not the raw acp-invite string, and an unknown pair returns revoked false. The read is local, idempotent, and side-effect free; bad arguments are JSON-RPC -32602.',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    inputSchema: objectSchema(
      'Optional filters for the in-memory revocation registry. targetId requires targetType.',
      {
        targetType: described(
          'Optional invite or capability filter. Omit it together with targetId to list every notice. Required when targetId is set.',
          { type: 'string', enum: ['invite', 'capability'] },
        ),
        targetId: described(
          'Optional target paired with targetType. For an invite this is the revocation digest, not the raw acp-invite string. For a capability this is the capability id. Passing it without targetType is JSON-RPC -32602.',
          { type: 'string' },
        ),
      },
    ),
    outputSchema: objectSchema(
      'Success payload in structuredContent. revoked is present only when both filters were supplied.',
      {
        count: described('Number of notices in this result after filtering.', {
          type: 'integer',
          minimum: 0,
        }),
        revoked: described(
          'True when both filters were supplied and that target is in the registry. False for an unknown pair. Omitted when either filter was omitted.',
          { type: 'boolean' },
        ),
        notices: described('Signed notices that matched the filter, newest replacement included when a target was revoked twice.', {
          type: 'array',
          items: signedRevocationSchema,
        }),
      },
      ['count', 'notices'],
    ),
  }),
];
