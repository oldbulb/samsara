#!/usr/bin/env node
// samsara-signoff: keygen | pending | confirm. The human side of the sign-off
// channel; the private key never leaves the file this CLI reads it from.
import { Command } from '@oldbulb/samsara-kernel'
import { SIGNOFF_ACTIONS, type SignoffAction } from './proof.ts'
import { confirm, keygen, pending, SignoffClientError } from './client.ts'

const program = new Command('samsara-signoff')

program
  .command('keygen')
  .requiredOption('--out <dir>', 'directory to write signoff.key (0600) and signoff.pub')
  .action(async (o: { out: string }) => {
    const paths = await keygen(o.out)
    process.stdout.write(`${paths.privateKeyPath}\n${paths.publicKeyPath}\n`)
  })

program
  .command('pending')
  .requiredOption('--socket <path>', 'sign-off socket path')
  .action(async (o: { socket: string }) => {
    for (const p of await pending(o.socket)) process.stdout.write(`${p.action}\t${p.rowId}\texpires ${p.expiresAt}\n`)
  })

program
  .command('confirm')
  .requiredOption('--socket <path>', 'sign-off socket path')
  .requiredOption('--key <private.pem>', 'private key file')
  .requiredOption('--row <id>', 'challenger row id (for gate_change: the gate policy name@version)')
  .requiredOption('--action <action>', SIGNOFF_ACTIONS.join('|'))
  .requiredOption('--who <name>', 'who is signing')
  .action(async (o: { socket: string; key: string; row: string; action: string; who: string }) => {
    if (!SIGNOFF_ACTIONS.includes(o.action as SignoffAction)) program.error(`--action must be one of ${SIGNOFF_ACTIONS.join(', ')}`)
    const consent = await confirm({ socketPath: o.socket, privateKeyPath: o.key, rowId: o.row, action: o.action as SignoffAction, who: o.who })
    process.stdout.write(consent.id + '\n')
  })

program.parseAsync(process.argv).catch((e: unknown) => {
  const msg = e instanceof SignoffClientError ? `[${e.code}] ${e.message}` : e instanceof Error ? e.message : String(e)
  process.stderr.write(`samsara-signoff: ${msg}\n`)
  process.exit(1)
})
