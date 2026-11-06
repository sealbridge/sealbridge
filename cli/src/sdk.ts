// SPDX-License-Identifier: Apache-2.0
/** Supported embedding surface for sealbridge/sdk. Keep exports explicit. */
export {
  InviteStore, KeychainSecretStore, openKeychainSecretStore,
  FileKeyStore, KeychainKeyStore, inspectStoredIdentity, resolveStoredIdentity,
  selectKeyStore, keyStoreSelection, keychainService, resolveDataRoot,
  readApplicationConfig, setApplicationKeyStore,
  WorkerTrustStore, workerIntakePath,
  ConnectionService, ConnectionRouter, syncConnections, StoredConnectionExchange, ConnectionAdmissionReview,
  HeldRequestReview, unavailableHeldContentReviewProvider, taskContent,
  createRuleBasedContentReviewProvider,
  AcpMcpServer,
  buildTaskManifest, appendContextGrantAuditEvent, CONTEXT_GRANT_AUDIT_EVENTS,
  RequesterClient, WorkerNode, verifyDelegationAttachment,
} from '@acp/runtime';
export type {
  SavedInvite, InviteStoreOptions, SecretStore,
  DataRootOptions, LocalIdentityOptions, IdentityRole, IdentityStoreOptions, StoredIdentity,
  KeyStore, KeyStoreDescription, KeyStoreSelection, KeyringEntry, KeyringModule,
  ApplicationConfig, ApplicationConfigOptions, RelaySelectionOptions,
  ConnectionState, ConnectionStatus, ConnectionTrust, ConnectionPeer, ConnectionRecord, ConnectionSummary, PriorApprovedPeer,
  ConnectionServiceOptions, ConnectionServiceResult, ConnectionHumanReviewProvider,
  ConnectionInspectionPort, ConnectionPersistencePort, ConnectionOffer, ConnectionConsent,
  ConnectionOutboxEntry, ConnectionAcceptanceCommit, ConnectionRedemptionCommit,
  ConnectionTransport, ConnectionFrame, ConnectionRouterOptions, ConnectedEvent,
  ConnectionAdmissionReviewOptions, InboundConnectionSummary,
  HeldRequestReviewOptions, HeldContentReviewProvider, HeldInspectionContext, InspectionCompletion, HeldTaskContent,
  RuleBasedContentReviewOptions,
  AcpMcpServerOptions, ApprovalProvider, ChildDelegationRequest,
} from '@acp/runtime';
export {
  inspectRuleContent, CONTENT_INSPECTION_RULES, CONTENT_INSPECTION_RULESET_VERSION,
  CONTENT_INSPECTION_RULESET_DIGEST, CONTENT_INSPECTION_LIMITS,
  generateKeyPair, createSignedAgentCard, verifySignedAgentCard,
  createInviteToken, inviteTokenFromUri, isInviteTarget, parseAndVerifyInviteToken,
  discoverAgentCards, findDiscoveredAgentCard,
  generateInviteLinkKey, deriveInviteLinkKeys, inviteLinkClaimTag, inviteLinkAad,
  padInviteLinkToken, unpadInviteLinkToken, encryptInviteLink, decryptInviteLink,
  packInviteLinkCiphertext, unpackInviteLinkCiphertext, parseInviteLink, inviteLinkExpiry,
  inviteLinkVerificationNumber,
  INVITE_LINK_CONTEXT, INVITE_LINK_HKDF_INFO, INVITE_LINK_PAD_BLOCK_BYTES, INVITE_LINK_MAX_PADDED_BYTES,
  INVITE_LINK_DEFAULT_TTL_MS, INVITE_LINK_MAX_TTL_MS, INVITE_LINK_TOKEN_GRACE_MS,
  buildContextGrant, validateContextGrant, validateManifest, validateContextGrantUse,
  assertDelegationAttenuation, createDelegationLink, verifyDelegationChain,
  contextGrantAuditPayload, CONTEXT_GRANT_MAX_BYTES, CONTEXT_GRANT_MAX_LIFETIME_MS,
  CONTEXT_GRANT_DEFAULT_LIFETIME_MS,
} from '@acp/core';
export type {
  RuleInspectionInput, RuleInspectionOptions, RuleInspectionFinding, RuleInspectionReport,
  RuleInspectionRule, RuleInspectionKind, RuleInspectionDiagnosticCode,
  KeyPair, Json, Signed, SignedEnvelope,
  ContextGrant, ContextGrantOptions, DeliveryMode, TaskManifest,
  ContextGrantAuditEventType, ContextGrantAuditPayload,
  DelegationLimits, DelegationLinkPayload, DelegationLink, DelegationProof, DelegationAttachment,
  Invite, AgentSkill, DiscoveryAgentCard, CreateAgentCardOptions, SignedAgentCard, RelayEndpointPolicy,
  ConnectionRequest, ConnectionAccepted, ConnectionAck, ConnectionControl,
  InviteLinkKeys, InviteLinkCiphertext, InviteLinkStorage, InviteLinkRelayPolicy, ParsedInviteLink,
} from '@acp/core';
export type { RelayTransport } from '@acp/relay';
export { connectionsCommand, connectionHumanReview } from './connections.js';
export type { ConnectionsCommandOptions } from './connections.js';
export { mcpServerCommand, parseMcpServerArgs, mcpServerOptionsFromArgs } from './mcp.js';
export type { ParsedMcpServerArgs } from './mcp.js';

export { parseJsonl, verifyAudit, parseAuditJsonl, verifyAuditEvidence, createAuditInterruption,
  JsonlStore, MemoryStore, BilateralLedger } from '@acp/ledger';
export type { AuditEntry, AuditBody, AuditBundle, Checkpoint, AuditStore, InterruptionStore,
  AuditInterruption, InterruptedAuditBundle, AuditEvidence, AuditFileRecord,
  AuditVerificationOptions, AuditTrustAnchor, AuditVerificationResult, AuditEvidenceTrustAnchor,
  AuditEvidenceVerificationOptions, AuditEvidenceVerificationResult, InterruptedAuditVerificationResult } from '@acp/ledger';
