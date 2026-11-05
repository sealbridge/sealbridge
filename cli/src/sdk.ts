// SPDX-License-Identifier: Apache-2.0
/** Supported embedding surface for sealbridge/sdk. Keep exports explicit. */
export {
  InviteStore, KeychainSecretStore, openKeychainSecretStore,
  FileKeyStore, KeychainKeyStore, inspectStoredIdentity, resolveStoredIdentity,
  selectKeyStore, keyStoreSelection, keychainService, resolveDataRoot,
  readApplicationConfig, setApplicationKeyStore,
  WorkerTrustStore, workerIntakePath,
  ConnectionService, ConnectionRouter, syncConnections, StoredConnectionExchange, ConnectionAdmissionReview,
  HeldRequestReview, unavailableHeldContentReviewProvider,
  AcpMcpServer,
  buildTaskManifest, appendContextGrantAuditEvent, CONTEXT_GRANT_AUDIT_EVENTS,
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
  HeldRequestReviewOptions, HeldContentReviewProvider, HeldInspectionContext, InspectionCompletion,
  AcpMcpServerOptions, ApprovalProvider,
} from '@acp/runtime';
export {
  generateKeyPair, createSignedAgentCard, verifySignedAgentCard,
  createInviteToken, inviteTokenFromUri, isInviteTarget, parseAndVerifyInviteToken,
  discoverAgentCards, findDiscoveredAgentCard,
  buildContextGrant, validateContextGrant, validateManifest, validateContextGrantUse,
  contextGrantAuditPayload, CONTEXT_GRANT_MAX_BYTES, CONTEXT_GRANT_MAX_LIFETIME_MS,
  CONTEXT_GRANT_DEFAULT_LIFETIME_MS,
} from '@acp/core';
export type {
  KeyPair, Json, Signed, SignedEnvelope,
  ContextGrant, ContextGrantOptions, DeliveryMode, TaskManifest,
  ContextGrantAuditEventType, ContextGrantAuditPayload,
  Invite, AgentSkill, DiscoveryAgentCard, CreateAgentCardOptions, SignedAgentCard, RelayEndpointPolicy,
  ConnectionRequest, ConnectionAccepted, ConnectionAck, ConnectionControl,
} from '@acp/core';
export type { RelayTransport } from '@acp/relay';
export { connectionsCommand, connectionHumanReview } from './connections.js';
export type { ConnectionsCommandOptions } from './connections.js';
export { mcpServerCommand, parseMcpServerArgs, mcpServerOptionsFromArgs } from './mcp.js';
export type { ParsedMcpServerArgs } from './mcp.js';
