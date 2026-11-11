# Local execution and storage

Local process adapters, credential proxies, sandbox execution, OS credential
storage, identity-file I/O and CLI hooks live here. This package depends only on
core, ledger, relay and sandbox; it must never import runtime or adapters, even for types.

Runtime keeps its public KeyStore/SecretStore and identity interfaces, store
selection, validation and application configuration. The implementations accept
structurally compatible local ports. adapter-port.ts describes the host context
consumed by local adapters, including the structural redelegation callback; the
credential proxy similarly needs only record() and an AbortController. These
ports avoid a reverse dependency on runtime. No initialization/registration order
or new backend defaults are introduced.

Legacy runtime, adapters and CLI modules re-export the same implementation
objects. OpenAI and MCP adapters remain in adapters. The package preparation
script discovers runtime-local and verifies the rewritten standalone facades and
SDK against its exports. Native keyring loading remains optional and lazy.
