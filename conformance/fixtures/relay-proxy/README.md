These public test fixtures are exclusively for the local proxy conformance tests.
`ca.pem` is a self-signed test CA; `relay.pem` is its server certificate for
`relay.example` and `relay.sealbridge.dev`, with `relay-key.pem` its public test
private key. Certificates expire in November 2036. The CA private key was
discarded. Never install this CA into a system trust store or use these keys
outside tests. Tests supply this CA explicitly and retain certificate and
hostname verification, including negative tests with no CA and a wrong hostname.
