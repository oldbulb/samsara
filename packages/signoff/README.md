# @oldbulb/samsara-signoff

`ctx.signoff`: the human consent channel. `request(rowId, action)` opens a 10-minute nonce; a person signs `{nonce, rowId, action, who, issuedAt}` with an Ed25519 key and submits the proof over a unix socket; `confirm(proof)` yields a `ConsentRecord` the ledger stores beside the verdict. `samsara-signoff keygen | pending | confirm` is the human side.

## Threat model (E2)

1. The loop (proposer, sandboxes, any agent) may control HTTP, the gateway and the webserver; none of those can produce a proof, because there is no HTTP route and a proof is a signature, not a request.
2. The private key lives in a 0600 file on the signer's side only; the host holds just the public key, so a compromised host cannot mint consents.
3. The socket is 0600 and owned by the host user; sandboxes run as other users or in other mounts and cannot connect, and a connection alone proves nothing without a signature.
4. Nonces are 32 random bytes, single-use, expire in 10 minutes and are bound to one row and action, so a captured proof cannot be replayed or redirected.
5. Every consent records `proof_sha`; the ledger can re-verify any historic consent against the public key, so a forged row is detectable after the fact.
