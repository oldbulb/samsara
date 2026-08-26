# @oldbulb/samsara-signoff

`ctx.signoff`: the human consent channel. `request(rowId, action, {roundId?})` opens a 10-minute nonce (a `promote` names the round it decides); a person signs `{nonce, rowId, action, who, issuedAt, roundId?}` with an Ed25519 key and submits the proof over a unix socket; `confirm(proof)` yields a `ConsentRecord` — the proof kept on it — that the ledger stores beside the verdict, and `verifyConsent(row)` checks a stored row again (proof present, hashes to `proof_sha` and `id`, names the row's subject, action and round, verifies under the public key) before the champion acts on it. `samsara-signoff keygen | pending | confirm` is the human side: `keygen --out <dir>` on the signer's machine, and only `signoff.pub` copied to the host's `publicKeyPath`.

## Threat model (E2)

1. The loop (proposer, sandboxes, any agent) may control HTTP, the gateway and the webserver; none of those can produce a proof, because there is no HTTP route and a proof is a signature, not a request.
2. The private key lives in a 0600 file on the signer's side only; the host holds just the public key, so a compromised host cannot mint consents. The service enforces the split it can see: while a `signoff.key` sits beside `publicKeyPath`, every confirm is refused with `KEY_ON_HOST`.
3. The socket is 0600 and owned by the host user; sandboxes run as other users or in other mounts and cannot connect, and a connection alone proves nothing without a signature.
4. Nonces are 32 random bytes, single-use, expire in 10 minutes and are bound to one row and action, so a captured proof cannot be replayed or redirected.
5. Every consent records `proof_sha` and the proof itself; `verifyConsent` re-verifies a stored row against the public key before a promotion, so a row inserted into the ledger by hand is refused, not merely detectable. A `promote` consent is bound to one round (`round_id`); `lifecycle.decide` accepts no other.
