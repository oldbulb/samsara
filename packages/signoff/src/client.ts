// Library half of the CLI: talk to the socket, sign a pending nonce, write
// keys. Pure node, no cordis — a human runs this from their own shell.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { join } from 'node:path'
import { generateKeypair, sign, type Proof, type SignoffAction } from './proof.ts'
import type { SocketRequest, SocketResponse } from './protocol.ts'
import type { ConsentRecord, PendingSignoff } from './index.ts'

export const PRIVATE_KEY_FILE = 'signoff.key'
export const PUBLIC_KEY_FILE = 'signoff.pub'

export class SignoffClientError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'SignoffClientError'
  }
}

/** Write a fresh keypair into `dir`: private key 0600, public key beside it. */
export async function keygen(dir: string): Promise<{ privateKeyPath: string; publicKeyPath: string }> {
  const { publicKey, privateKey } = generateKeypair()
  await mkdir(dir, { recursive: true })
  const privateKeyPath = join(dir, PRIVATE_KEY_FILE)
  const publicKeyPath = join(dir, PUBLIC_KEY_FILE)
  await writeFile(privateKeyPath, privateKey, { mode: 0o600, flag: 'wx' })
  await writeFile(publicKeyPath, publicKey, { mode: 0o644, flag: 'wx' })
  return { privateKeyPath, publicKeyPath }
}

/** One request/response exchange on the socket. */
export function exchange(socketPath: string, req: SocketRequest): Promise<SocketResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.once('error', reject)
    socket.on('connect', () => socket.write(JSON.stringify(req) + '\n'))
    socket.on('data', chunk => {
      buffer += chunk
      const nl = buffer.indexOf('\n')
      if (nl < 0) return
      socket.end()
      try {
        resolve(JSON.parse(buffer.slice(0, nl)) as SocketResponse)
      } catch (e) {
        reject(e)
      }
    })
    socket.on('close', () => reject(new SignoffClientError('socket closed before a response', 'NO_RESPONSE')))
  })
}

function unwrap<T>(res: SocketResponse): T {
  if (res.ok) return res.result as T
  throw new SignoffClientError(res.message, res.code)
}

export async function pending(socketPath: string): Promise<PendingSignoff[]> {
  return unwrap<PendingSignoff[]>(await exchange(socketPath, { op: 'pending' }))
}

export interface ConfirmOptions {
  socketPath: string
  privateKeyPath: string
  rowId: string
  action: SignoffAction
  who: string
}

/** Find the pending nonce for the row+action, sign it with the key file, submit, return the consent. */
export async function confirm(o: ConfirmOptions): Promise<ConsentRecord> {
  const entry = (await pending(o.socketPath)).find(p => p.rowId === o.rowId && p.action === o.action)
  if (!entry) throw new SignoffClientError(`no pending ${o.action} sign-off for row ${o.rowId}`, 'NOT_PENDING')
  const privateKey = await readFile(o.privateKeyPath, 'utf8')
  const payload = { nonce: entry.nonce, rowId: o.rowId, action: o.action, who: o.who, issuedAt: new Date().toISOString() }
  const proof: Proof = { payload, signature: sign(privateKey, payload) }
  return unwrap<ConsentRecord>(await exchange(o.socketPath, { op: 'confirm', proof }))
}
