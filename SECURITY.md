# Reporting a security issue

[日本語](SECURITY.ja.md)

Please report suspected vulnerabilities privately to **security@sealbridge.dev**.
Include the affected version or commit, reproduction steps, impact and any
suggested mitigation. Do not include private keys, credentials, live invite
tokens or private task payloads. Use synthetic examples where possible.

Avoid public issues for unpatched vulnerabilities. The maintainer will review
the report and coordinate disclosure; no response-time guarantee is promised.
For the threat model and isolation boundaries, see the
[security model](docs/security-model.md) and [security proofs](SECURITY_PROOF.md).

General questions: hello@sealbridge.dev. Invite-page questions:
hello@sealbridge.app.

### Synthetic DNS and TLS egress

For HTTPS/WSS hostnames only, relay clients detect local synthetic DNS when every
relay answer is in 198.18.0.0/15 and a random sb-UUID.invalid canary also returns
only that range. The bounded canary result is cached once per process resolver;
NXDOMAIN, timeout, empty or mixed answers fail closed. Literal IPs, plaintext
HTTP/WS, credentials, metadata names and .local/.internal retain URL policy.
Normal DNS routes still validate and pin every answer.

The synthetic route connects by hostname with normal TLS verification and SNI,
without pinning the benchmark address. The local SNI egress proxy chooses the
destination by hostname, the same trust as explicitly configured HTTPS_PROXY;
an invitation cannot alter the local resolver. TLS prevents impersonation of the
relay. This trusts the environment's egress policy, not a remote DNS answer alone.
SAND_EGRESS_TUNNEL_PROXY_ADDR is not read; detection needs no undocumented settings.
