// REAL-composition coverage: a test-only cordis.yml booted through the Loader
// mounts the real @deepseek-ai/dsh-host-webserver on port 0 next to the
// samsara-ui row (ledger / champion / signoff are fake services), and every
// assertion observes the served HTTP surface.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, HttpServer, Include, Loader, Service } from '@samsara/kernel'
import * as Ui from '../src/index.ts'
import { CHAL, fakeDeps } from './fixtures.ts'

const deps = fakeDeps()

class FakeLedger extends Service {
  constructor(ctx: Context) { super(ctx, 'ledger') }
  read = deps.ledger.read
  challenger = deps.ledger.challenger
  lineage = deps.ledger.lineage
}
class FakeChampion extends Service {
  constructor(ctx: Context) { super(ctx, 'champion') }
  current = deps.champion.current
  replayCheck = deps.champion.replayCheck
}
class FakeSignoff extends Service {
  constructor(ctx: Context) { super(ctx, 'signoff') }
  config = { socketPath: deps.signoff.socketPath }
  pending = deps.signoff.pending
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadComposition(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'samsara-ui-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    '- name: fake-ledger',
    '- name: fake-champion',
    '- name: fake-signoff',
    '- id: ui',
    "  name: '@samsara/ui'",
    '  config:',
    '    refreshMs: 1000',
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['fake-ledger', FakeLedger],
    ['fake-champion', FakeChampion],
    ['fake-signoff', FakeSignoff],
    ['@samsara/ui', Ui],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  return context
}

async function request(port: number, path: string, init?: RequestInit) {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, init)
  return { status: response.status, type: response.headers.get('content-type'), body: await response.text() }
}

describe('real Loader composition', () => {
  it('serves the page and the API on the prefix route, 404/405 elsewhere, and releases the route on dispose', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const unloaded = [...loaded.loader.entries()].filter((e) => e.fiber === undefined && !e.disabled).map((e) => e.options.name)
    expect(unloaded).toEqual([])
    const port = loaded.webServer.port

    const page = await request(port, '/samsara')
    expect(page.status).toBe(200)
    expect(page.type).toBe('text/html; charset=utf-8')
    expect(page.body).toContain('Champion')
    expect((await request(port, '/samsara/?challenger=abc')).status).toBe(200)

    const summary = await request(port, '/samsara/api/summary')
    expect(summary.status).toBe(200)
    expect(summary.type).toBe('application/json; charset=utf-8')
    const parsed = JSON.parse(summary.body)
    expect(Object.keys(parsed.tiers)).toEqual(['smoke', 'holdin', 'holdout', 'live'])
    expect(parsed.pendingSignoffs[0].rowId).toBe(CHAL)

    expect(JSON.parse((await request(port, `/samsara/api/challenger/${CHAL}`)).body).row.id).toBe(CHAL)
    expect((await request(port, '/samsara/api/nope')).status).toBe(404)
    expect((await request(port, '/samsara/api/summary', { method: 'POST' })).status).toBe(405)
    // Outside the prefix the unclaimed webserver answers for itself.
    expect((await request(port, '/elsewhere')).status).toBe(404)

    const entry = [...loaded.loader.entries()].find((e) => e.options.id === 'ui')
    await entry!.fiber?.dispose()
    expect((await request(port, '/samsara')).status).toBe(404)
  })
})
