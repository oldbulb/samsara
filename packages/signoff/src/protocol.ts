// The newline-delimited JSON spoken on the socket, shared by the service and
// the CLI client. One request line in, one response line out.

import type { Proof } from './proof.ts'

export const SIGNOFF_SOCKET_MODE = 0o600

export type SocketRequest =
  | { op: 'pending' }
  | { op: 'confirm'; proof: Proof }

export type SocketResponse =
  | { ok: true; result: unknown }
  | { ok: false; code: string; message: string }

export function parseSocketRequest(line: string): SocketRequest {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new Error('request line is not JSON')
  }
  if (!value || typeof value !== 'object') throw new Error('request must be an object')
  const req = value as Record<string, unknown>
  if (req['op'] === 'pending') return { op: 'pending' }
  if (req['op'] === 'confirm') return { op: 'confirm', proof: req['proof'] as Proof }
  throw new Error(`unknown op "${String(req['op'])}"`)
}
