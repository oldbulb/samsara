// @samsara/signoff — `ctx.signoff`: the consent channel the loop cannot reach.
//
// A caller inside the host asks `request(rowId, action)` for a nonce; a human
// signs {nonce, rowId, action, who, issuedAt} with a private key that lives in
// a 0600 file on their side, and submits the proof over a 0600 unix socket.
// `confirm` turns a valid proof into a ConsentRecord. There is no HTTP route:
// anything that can only present an HTTP request has no proof (E2).

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { Context, Schema, Service } from '@samsara/kernel'
import {
  SIGNOFF_ACTIONS,
  proofSha,
  sha256,
  canonicalJson,
  verify,
  type Proof,
  type ProofPayload,
  type SignoffAction,
} from './proof.ts'

export * from './proof.ts'
export { SIGNOFF_SOCKET_MODE, parseSocketRequest, type SocketRequest, type SocketResponse } from './protocol.ts'
import { SIGNOFF_SOCKET_MODE, parseSocketRequest, type SocketResponse } from './protocol.ts'

declare module '@samsara/kernel' {
  interface Context {
    signoff: Signoff
  }
}

export interface Config {
  /** Unix domain socket path the service listens on (created 0600). */
  socketPath: string
  /** PEM (spki) Ed25519 public key every proof must verify against. */
  publicKeyPath: string
}

export const Config: Schema<Config> = Schema.object({
  socketPath: Schema.string().required(),
  publicKeyPath: Schema.string().required(),
})

export type SignoffErrorCode = 'UNKNOWN_NONCE' | 'EXPIRED' | 'BAD_SIGNATURE' | 'ROW_MISMATCH' | 'BAD_REQUEST' | 'NO_KEY'

export class SignoffError extends Error {
  constructor(message: string, readonly code: SignoffErrorCode) {
    super(message)
    this.name = 'SignoffError'
  }
}

export interface PendingSignoff {
  nonce: string
  rowId: string
  action: SignoffAction
  /** ISO time after which the nonce is no longer accepted. */
  expiresAt: string
}

export interface ConsentRecord {
  id: string
  challenger_id: string
  action: SignoffAction
  who: string
  channel: 'unix-socket'
  proof_sha: string
  at: string
}

export const PENDING_TTL_MS = 10 * 60 * 1000

/** Clock seam for tests; production never touches it. */
export const internals = { now: () => Date.now() }

export class Signoff extends Service {
  static Config = Config

  private readonly pendingByNonce = new Map<string, PendingSignoff>()
  private readonly confirmListeners = new Set<(consent: ConsentRecord) => void>()
  /** Settles once the socket is listening (the effect is async; the constructor is not). */
  readonly ready: Promise<void>

  constructor(ctx: Context, readonly config: Config) {
    super(ctx, 'signoff')
    if (!existsSync(config.publicKeyPath)) {
      process.stderr.write(`signoff: no public key at ${config.publicKeyPath}; every confirm is refused until one exists\n`)
    }
    this.ready = Promise.resolve(ctx.effect(async () => {
      const server = await this.listen(config.socketPath)
      return async () => {
        await new Promise<void>(resolve => server.close(() => resolve()))
        await rm(config.socketPath, { force: true })
      }
    }, 'signoff.listen()')).then(() => {})
  }

  /** Open a pending sign-off for a row; the nonce is what the human must sign. */
  request(rowId: string, action: SignoffAction): PendingSignoff {
    if (!SIGNOFF_ACTIONS.includes(action)) throw new SignoffError(`unknown action "${action}"`, 'BAD_REQUEST')
    if (!rowId) throw new SignoffError('rowId is required', 'BAD_REQUEST')
    this.purge()
    const nonce = randomBytes(32).toString('hex')
    const pending: PendingSignoff = {
      nonce,
      rowId,
      action,
      expiresAt: new Date(internals.now() + PENDING_TTL_MS).toISOString(),
    }
    this.pendingByNonce.set(nonce, pending)
    return pending
  }

  /** Observe every consent the socket confirms (the host persists it to the ledger); returns the disposer. */
  onConfirm(listener: (consent: ConsentRecord) => void): () => void {
    this.confirmListeners.add(listener)
    return () => { this.confirmListeners.delete(listener) }
  }

  /** Unexpired pending sign-offs, oldest first. */
  pending(): PendingSignoff[] {
    this.purge()
    return [...this.pendingByNonce.values()]
  }

  /**
   * Turn a proof into a consent. Throws SignoffError unless the nonce is
   * pending and unexpired, the payload names the same row and action, and the
   * signature verifies under the configured public key. A nonce is consumed
   * on success.
   */
  confirm(proof: Proof): ConsentRecord {
    const payload = checkPayload(proof)
    const pending = this.pendingByNonce.get(payload.nonce)
    if (!pending) throw new SignoffError('nonce is not pending', 'UNKNOWN_NONCE')
    if (Date.parse(pending.expiresAt) <= internals.now()) {
      this.pendingByNonce.delete(payload.nonce)
      throw new SignoffError('pending sign-off has expired', 'EXPIRED')
    }
    if (pending.rowId !== payload.rowId || pending.action !== payload.action) {
      throw new SignoffError('proof names a different row or action than the pending sign-off', 'ROW_MISMATCH')
    }
    if (!verify(this.publicKey(), payload, proof.signature)) {
      throw new SignoffError('signature does not verify against the configured public key', 'BAD_SIGNATURE')
    }
    this.pendingByNonce.delete(payload.nonce)
    const proof_sha = proofSha({ payload, signature: proof.signature })
    const at = new Date(internals.now()).toISOString()
    return {
      id: sha256(canonicalJson(['consent', proof_sha])),
      challenger_id: payload.rowId,
      action: payload.action,
      who: payload.who,
      channel: 'unix-socket',
      proof_sha,
      at,
    }
  }

  /** Read on every confirm: fail closed while the file is absent, pick it up once it exists. */
  private publicKey(): string {
    try {
      return readFileSync(this.config.publicKeyPath, 'utf8')
    } catch {
      throw new SignoffError(`no public key at ${this.config.publicKeyPath}`, 'NO_KEY')
    }
  }

  private purge(): void {
    const now = internals.now()
    for (const [nonce, p] of this.pendingByNonce) {
      if (Date.parse(p.expiresAt) <= now) this.pendingByNonce.delete(nonce)
    }
  }

  // ------------------------------------------------------------- the socket

  private async listen(path: string): Promise<Server> {
    await rm(path, { force: true })
    const server = createServer(socket => this.serve(socket))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => { server.off('error', reject); resolve() })
    })
    await chmod(path, SIGNOFF_SOCKET_MODE)
    return server
  }

  private serve(socket: Socket): void {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('error', () => { /* a dropped client is not our problem */ })
    socket.on('data', chunk => {
      buffer += chunk
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (line.trim()) socket.write(JSON.stringify(this.handle(line)) + '\n')
      }
    })
  }

  private handle(line: string): SocketResponse {
    try {
      const req = parseSocketRequest(line)
      if (req.op === 'pending') return { ok: true, result: this.pending() }
      const consent = this.confirm(req.proof)
      for (const listener of this.confirmListeners) listener(consent)
      return { ok: true, result: consent }
    } catch (e) {
      if (e instanceof SignoffError) return { ok: false, code: e.code, message: e.message }
      return { ok: false, code: 'BAD_REQUEST', message: e instanceof Error ? e.message : String(e) }
    }
  }
}

function checkPayload(proof: Proof): ProofPayload {
  const p = proof?.payload
  if (!p || typeof p !== 'object' || typeof proof.signature !== 'string') {
    throw new SignoffError('proof must carry a payload object and a signature string', 'BAD_REQUEST')
  }
  const { nonce, rowId, action, who, issuedAt } = p
  for (const [k, v] of Object.entries({ nonce, rowId, who, issuedAt })) {
    if (typeof v !== 'string' || !v) throw new SignoffError(`payload.${k} must be a non-empty string`, 'BAD_REQUEST')
  }
  if (!SIGNOFF_ACTIONS.includes(action)) throw new SignoffError(`unknown action "${String(action)}"`, 'BAD_REQUEST')
  return { nonce, rowId, action, who, issuedAt }
}

// The loader mounts this module as the `signoff` row: a Service class is a plugin.
export default Signoff
