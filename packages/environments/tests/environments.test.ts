import { describe, expect, it } from 'vitest'
import { Context } from '@oldbulb/samsara-kernel'
import { Environments, EnvironmentsError, environmentSha, type Environment, type EnvironmentFacts, type EnvironmentProvider, type EnvironmentSpec } from '../src/index.ts'

function spec(attemptId = 'att-1'): EnvironmentSpec {
  return { attemptId, resources: { timeoutS: 60 }, network: 'none', env: {}, mounts: [] }
}

function fakeProvider(name: string, opened: EnvironmentSpec[] = []): EnvironmentProvider {
  return {
    name,
    version: '0',
    async open(s): Promise<Environment> {
      opened.push(s)
      return {
        id: `${name}:${s.attemptId}`,
        provider: name,
        workdir: '/w',
        async exec() { return { code: 0, stdout: '', stderr: '' } },
        async put() {},
        async get() {},
        facts: () => ({ provider: name, version: '0', resources: s.resources, network: s.network }),
        async dispose() {},
      }
    },
  }
}

async function registry() {
  const ctx = new Context()
  await ctx.plugin(Environments)
  return ctx
}

describe('Environments', () => {
  it('registers, rejects duplicates, and removes on dispose', async () => {
    const ctx = await registry()
    const p = fakeProvider('fake')
    const dispose = ctx.environments.register(p)
    expect(ctx.environments.get('fake')).toBe(p)
    expect(ctx.environments.list().map((x) => x.name)).toEqual(['fake'])
    let err: unknown
    try { ctx.environments.register(fakeProvider('fake')) } catch (e) { err = e }
    expect(err).toBeInstanceOf(EnvironmentsError)
    expect((err as EnvironmentsError).code).toBe('DUPLICATE_PROVIDER')
    dispose()
    expect(ctx.environments.get('fake')).toBeUndefined()
    expect(ctx.environments.list()).toEqual([])
  })

  it('open() resolves the provider by name and throws on an unknown one', async () => {
    const ctx = await registry()
    const opened: EnvironmentSpec[] = []
    ctx.environments.register(fakeProvider('fake', opened))
    const env = await ctx.environments.open('fake', spec('a1'))
    expect(env.id).toBe('fake:a1')
    expect(opened).toHaveLength(1)
    expect(() => ctx.environments.open('nope', spec())).toThrow(EnvironmentsError)
    try { ctx.environments.open('nope', spec()) } catch (e) { expect((e as EnvironmentsError).code).toBe('UNKNOWN_PROVIDER') }
  })

  it('registrations end with the plugin scope that made them', async () => {
    const ctx = await registry()
    const fiber = await ctx.plugin({ name: 'p', inject: ['environments'], apply: (c: Context) => { c.environments.register(fakeProvider('scoped')) } })
    expect(ctx.environments.get('scoped')).toBeDefined()
    await fiber.dispose()
    expect(ctx.environments.get('scoped')).toBeUndefined()
  })
})

describe('environmentSha', () => {
  const base: EnvironmentFacts = { provider: 'docker', version: '0.1.0', image: { ref: 'img:1', digest: 'sha256:abc' }, resources: { cpus: 2, memoryMb: 1024, timeoutS: 600 }, network: 'none' }

  it('is deterministic and independent of key order', () => {
    const reordered: EnvironmentFacts = { network: 'none', resources: { timeoutS: 600, memoryMb: 1024, cpus: 2 }, image: { digest: 'sha256:abc', ref: 'img:1' }, version: '0.1.0', provider: 'docker' }
    expect(environmentSha(base)).toMatch(/^[0-9a-f]{64}$/)
    expect(environmentSha(reordered)).toBe(environmentSha(base))
  })

  it('does not depend on the provider or its version (rule 0: one image on two providers is one design)', () => {
    expect(environmentSha({ ...base, provider: 'modal', version: '9.9.9' })).toBe(environmentSha(base))
  })

  it('changes with the image digest, the resources, the network and the allowed hosts', () => {
    const sha = environmentSha(base)
    expect(environmentSha({ ...base, image: { ref: 'img:1', digest: 'sha256:def' } })).not.toBe(sha)
    expect(environmentSha({ ...base, resources: { ...base.resources, cpus: 4 } })).not.toBe(sha)
    expect(environmentSha({ ...base, network: 'public' })).not.toBe(sha)
    expect(environmentSha({ ...base, allowedHosts: ['a'] })).not.toBe(sha)
  })

  it('hashes the digest when present, else the ref, else null; the ref is ignored beside a digest', () => {
    expect(environmentSha({ ...base, image: { ref: 'other:2', digest: 'sha256:abc' } })).toBe(environmentSha(base))
    expect(environmentSha({ ...base, image: { ref: 'img:1' } })).not.toBe(environmentSha(base))
    const local: EnvironmentFacts = { provider: 'local', version: '0.1.0', resources: base.resources, network: 'none' }
    expect(environmentSha(local)).toBe(environmentSha({ ...local, image: {} }))
    expect(environmentSha(local)).toBe(environmentSha({ ...local, image: undefined }))
  })
})
