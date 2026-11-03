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
} from '@acp/core';
export type {
  KeyPair, Json, Signed, SignedEnvelope,
  Invite, AgentSkill, DiscoveryAgentCard, CreateAgentCardOptions, SignedAgentCard, RelayEndpointPolicy,
  ConnectionRequest, ConnectionAccepted, ConnectionAck, ConnectionControl,
} from '@acp/core';
export type { RelayTransport } from '@acp/relay';
export { connectionsCommand, connectionHumanReview } from './connections.js';
export type { ConnectionsCommandOptions } from './connections.js';
export { mcpServerCommand, parseMcpServerArgs, mcpServerOptionsFromArgs } from './mcp.js';
export type { ParsedMcpServerArgs } from './mcp.js';
