import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { containerName, imageIdentity, repositoryOf } from '../src/docker.ts'
import { DockerEnvironmentProvider, DockerEnvironment, envFileText, environmentSha, runArgv, type EnvironmentSpec } from '../src/index.ts'
import { realSpawn } from './fixtures/real-spawn.ts'

const roots: string[] = []
function tempRoot(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'samsara-env-docker-')))
  roots.push(dir)
  return dir
}
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })

function spec(over: Partial<EnvironmentSpec> = {}): EnvironmentSpec {
  return { attemptId: 'att-1', image: { ref: 'example/image:1' }, resources: { cpus: 2, memoryMb: 512, timeoutS: 600 }, network: 'none', env: { A: '1', TOKEN_VALUE: 'secret-value' }, mounts: [], ...over }
}

/**
 * A fake `docker` on PATH: records every call's argv (one file per call under
 * `calls/`, one line per argument) and answers canned output by subcommand.
 * `image inspect` answers `{{.Id}} {{json .RepoDigests}}`: an id-shaped image
 * has no repo digest, `missing/img:1` does not exist until a `pull` was
 * recorded; `run` fails for a container name containing `runfail`; `exec`
 * echoes its stdin to stdout and the container id to stderr, an argv
 * containing `--fail` exits 7, `--hang` sleeps, `test -d` is true for a path
 * ending in `-dir`.
 */
function fakeDocker(root: string): { bin: string; calls: () => string[][] } {
  const bin = join(root, 'bin')
  const calls = join(root, 'calls')
  mkdirSync(bin)
  mkdirSync(calls)
  const script = `#!/bin/sh
calls="${calls}"
n=$(ls "$calls" | wc -l | tr -d ' ')
printf '%s\\n' "$@" > "$calls/call-$(printf '%04d' "$n")"
case "$1" in
  build) echo "sha256:built0000"; exit 0 ;;
  pull) exit 0 ;;
  image)
    img="$5"
    case "$img" in
      sha256:*) echo "$img []"; exit 0 ;;
      missing/img:1)
        pulled=0; for f in "$calls"/*; do [ "$(head -1 "$f")" = pull ] && pulled=1; done
        [ "$pulled" = 1 ] || { echo "Error: No such image: $img" >&2; exit 1; }
        echo "sha256:id0000 [\\"missing/img@sha256:pulled0000\\"]"; exit 0 ;;
      *) echo "sha256:id0000 [\\"\${img%%:*}@sha256:repo0000\\"]"; exit 0 ;;
    esac ;;
  run)
    for a in "$@"; do case "$a" in *runfail*) echo "executable file not found" >&2; exit 127 ;; esac; done
    echo "cid0000"; exit 0 ;;
  commit) echo "sha256:snap0000"; exit 0 ;;
  cp|rm|kill|start) exit 0 ;;
  exec)
    for a in "$@"; do
      [ "$a" = "--fail" ] && { echo "failed" >&2; exit 7; }
      [ "$a" = "--hang" ] && sleep 30
      [ "$a" = "test" ] && { eval "last=\\\${$#}"; case "$last" in *-dir) exit 0 ;; *) exit 1 ;; esac; }
    done
    cat; echo "$2" >&2; exit 0 ;;
  *) echo "unknown $1" >&2; exit 1 ;;
esac
`
  writeFileSync(join(bin, 'docker'), script)
  chmodSync(join(bin, 'docker'), 0o755)
  return {
    bin,
    calls: () => readdirSync(calls).sort().map((f) => readFileSync(join(calls, f), 'utf8').replace(/\n$/, '').split('\n')),
  }
}

function withPath(bin: string): () => void {
  const saved = process.env['PATH']
  process.env['PATH'] = `${bin}:${saved ?? ''}`
  return () => { process.env['PATH'] = saved }
}

function provider(root: string): DockerEnvironmentProvider {
  return new DockerEnvironmentProvider({ spawn: realSpawn, baseDir: join(root, 'base'), graceMs: 200 })
}

describe('envFileText / runArgv / image identity / container name', () => {
  it('writes KEY=VALUE lines and rejects names and values an env file cannot carry', () => {
    expect(envFileText({ A: '1', B: 'x=y z' })).toBe('A=1\nB=x=y z\n')
    expect(envFileText({})).toBe('')
    expect(() => envFileText({ 'bad name': '1' })).toThrow(/invalid environment name/)
    expect(() => envFileText({ A: 'a\nb' })).toThrow(/newline/)
  })

  it('builds the run argv: name, resources, network, env file, mounts, workdir, image and the keep-alive command', () => {
    const s = spec({ mounts: [{ from: '/host/ro', to: '/c/ro', readOnly: true }, { from: '/host/rw', to: '/c/rw', readOnly: false }] })
    expect(runArgv(s, 'img', '/tmp/x.env', '/workspace', 'samsara-att-1-abcdef')).toEqual([
      'run', '-d', '--name', 'samsara-att-1-abcdef', '--label', 'samsara.attempt=att-1', '--cpus', '2', '--memory', '512m', '--network', 'none', '--env-file', '/tmp/x.env',
      '-v', '/host/ro:/c/ro:ro', '-v', '/host/rw:/c/rw:rw', '-w', '/workspace', 'img', 'sleep', 'infinity',
    ])
    expect(runArgv(spec({ resources: { timeoutS: 1 }, network: 'public', env: {} }), 'img', undefined, '/w', 'n')).toEqual(['run', '-d', '--name', 'n', '--label', 'samsara.attempt=att-1', '--network', 'bridge', '-w', '/w', 'img', 'sleep', 'infinity'])
    expect(runArgv(spec({ network: 'allowlist', allowedHosts: ['h'] }), 'img', undefined, '/w', 'n')).toContain('none')
  })

  it('image identity: the registry digest of the ref\'s repository, else the first, else the id; a ref\'s repository drops tag and digest but not a port', () => {
    expect(repositoryOf('alpine:3.20')).toBe('alpine')
    expect(repositoryOf('localhost:5000/team/img')).toBe('localhost:5000/team/img')
    expect(repositoryOf('localhost:5000/team/img:v1')).toBe('localhost:5000/team/img')
    expect(repositoryOf('alpine@sha256:aa')).toBe('alpine')
    expect(imageIdentity('sha256:id ["other/img@sha256:bb","alpine@sha256:aa"]', 'alpine:3.20')).toEqual({ id: 'sha256:id', digest: 'sha256:aa' })
    expect(imageIdentity('sha256:id ["other/img@sha256:bb"]', 'alpine:3.20')).toEqual({ id: 'sha256:id', digest: 'sha256:bb' })
    expect(imageIdentity('sha256:id []', 'alpine:3.20')).toEqual({ id: 'sha256:id', digest: 'sha256:id' })
    expect(imageIdentity('sha256:id null')).toEqual({ id: 'sha256:id', digest: 'sha256:id' })
    expect(imageIdentity('sha256:id')).toEqual({ id: 'sha256:id', digest: 'sha256:id' })
  })

  it('container name: the attempt (sanitised) plus the private directory\'s random suffix', () => {
    expect(containerName('att-1', '/base/docker-att-1-Xy12ab')).toBe('samsara-att-1-Xy12ab')
    expect(containerName('a:b c', '/base/docker-a:b c-Xy12ab')).toBe('samsara-a-b-c-Xy12ab')
  })
})

describe('DockerEnvironmentProvider against a fake docker CLI', () => {
  it('open: inspects the ref (no pull when it is on the daemon), runs the image id under a name with the env file (values never on the argv), exposes facts with the registry digest', async () => {
    const root = tempRoot()
    const fake = fakeDocker(root)
    const restore = withPath(fake.bin)
    try {
      const env = (await provider(root).open(spec())) as DockerEnvironment
      expect(env.provider).toBe('docker')
      expect(env.id).toBe('cid0000')
      // the pack contract names the workdir after the attempt
      expect(env.workdir).toBe('/workspace/att-1')
      const calls = fake.calls()
      expect(calls.map((c) => c[0])).toEqual(['image', 'run'])
      expect(calls[0]).toEqual(['image', 'inspect', '--format', '{{.Id}} {{json .RepoDigests}}', 'example/image:1'])
      const run = calls[1]!
      expect(run.slice(0, 3)).toEqual(['run', '-d', '--name'])
      expect(run[3]).toMatch(/^samsara-att-1-[A-Za-z0-9]{6}$/)
      expect(run).toContain('--env-file')
      const envFile = run[run.indexOf('--env-file') + 1]!
      expect(readFileSync(envFile, 'utf8')).toBe('A=1\nTOKEN_VALUE=secret-value\n')
      expect(run.join(' ')).not.toContain('secret-value')
      // the resolved id, not the tag: the tag may move while the run is on
      expect(run.slice(-3)).toEqual(['sha256:id0000', 'sleep', 'infinity'])
      expect(env.facts()).toEqual({ provider: 'docker', version: env.facts().version, image: { ref: 'example/image:1', digest: 'sha256:repo0000' }, resources: { cpus: 2, memoryMb: 512, timeoutS: 600 }, network: 'none' })
      expect(environmentSha(env.facts())).toBe(environmentSha({ ...env.facts(), provider: 'modal', version: '0' }))
      await env.dispose()
      expect(fake.calls().at(-1)).toEqual(['rm', '-f', 'cid0000'])
      expect(existsSync(envFile)).toBe(false)
    } finally {
      restore()
    }
  })

  it('open: a ref absent from the daemon is pulled once per provider; a second open of the same ref does no image call and runs the same id', async () => {
    const root = tempRoot()
    const fake = fakeDocker(root)
    const restore = withPath(fake.bin)
    try {
      const p = provider(root)
      const first = await p.open(spec({ image: { ref: 'missing/img:1' } }))
      expect(fake.calls().map((c) => c[0])).toEqual(['image', 'pull', 'image', 'run'])
      expect(fake.calls()[1]).toEqual(['pull', '-q', 'missing/img:1'])
      expect(first.facts().image).toEqual({ ref: 'missing/img:1', digest: 'sha256:pulled0000' })
      const second = await p.open(spec({ attemptId: 'att-2', image: { ref: 'missing/img:1' } }))
      const calls = fake.calls()
      expect(calls.slice(4).map((c) => c[0])).toEqual(['run'])
      expect(calls[4]!.slice(-3)).toEqual(['sha256:id0000', 'sleep', 'infinity'])
      expect(second.facts().image).toEqual(first.facts().image)
      await first.dispose()
      await second.dispose()
    } finally {
      restore()
    }
  })

  it('open: builds from dockerfileDir, facts carry the image id as digest and no ref; an empty env writes no env file', async () => {
    const root = tempRoot()
    const fake = fakeDocker(root)
    const restore = withPath(fake.bin)
    try {
      const ctxDir = join(root, 'ctx')
      mkdirSync(ctxDir)
      const env = await provider(root).open(spec({ image: { dockerfileDir: ctxDir }, env: {} }))
      const calls = fake.calls()
      expect(calls[0]).toEqual(['build', '-q', ctxDir])
      expect(calls[1]).toEqual(['image', 'inspect', '--format', '{{.Id}} {{json .RepoDigests}}', 'sha256:built0000'])
      expect(calls[2]).not.toContain('--env-file')
      expect(calls[2]!.slice(-3)).toEqual(['sha256:built0000', 'sleep', 'infinity'])
      expect(env.facts().image).toEqual({ digest: 'sha256:built0000' })
      await env.dispose()
    } finally {
      restore()
    }
  })

  it('open: a spec without an image is refused before any docker call; a failing client surfaces its stderr', async () => {
    const root = tempRoot()
    const fake = fakeDocker(root)
    const restore = withPath(fake.bin)
    try {
      await expect(provider(root).open(spec({ image: undefined }))).rejects.toThrow(/names no image/)
      await expect(provider(root).open(spec({ attemptId: 'a/b' }))).rejects.toThrow(/single path segment/)
      expect(fake.calls()).toEqual([])
      await expect(new DockerEnvironmentProvider({ spawn: realSpawn, baseDir: join(root, 'base'), docker: join(fake.bin, 'docker') }).open({ ...spec(), image: { ref: 'x' }, env: { A: 'a\nb' } })).rejects.toThrow(/newline/)
      expect(readdirSync(join(root, 'base'))).toEqual([])
    } finally {
      restore()
    }
  })

  it('open: a failed `run` removes whatever it left under the container name, then the private directory', async () => {
    const root = tempRoot()
    const fake = fakeDocker(root)
    const restore = withPath(fake.bin)
    try {
      await expect(provider(root).open(spec({ attemptId: 'att-runfail' }))).rejects.toThrow(/run exited with code 127.*executable file not found/)
      const calls = fake.calls()
      expect(calls.map((c) => c[0])).toEqual(['image', 'run', 'rm'])
      const name = calls[1]![calls[1]!.indexOf('--name') + 1]!
      expect(name).toMatch(/^samsara-att-runfail-[A-Za-z0-9]{6}$/)
      expect(calls[2]).toEqual(['rm', '-f', name])
      expect(readdirSync(join(root, 'base'))).toEqual([])
    } finally {
      restore()
    }
  })

  it('exec: docker exec -i with cwd/user, stdin delivered, extras through an env file, exit code', async () => {
    const root = tempRoot()
    const fake = fakeDocker(root)
    const restore = withPath(fake.bin)
    try {
      const env = await provider(root).open(spec())
      const r = await env.exec(['sh', '-c', 'cat'], { stdin: 'in-data', cwd: '/workspace/sub', user: 'nobody', env: { X: 'y' }, timeoutMs: 5000 })
      expect(r).toEqual({ code: 0, stdout: 'in-data', stderr: '-i\n' })
      const call = fake.calls().at(-1)!
      expect(call.slice(0, 2)).toEqual(['exec', '-i'])
      expect(call).toContain('-w')
      expect(call[call.indexOf('-w') + 1]).toBe('/workspace/sub')
      expect(call[call.indexOf('-u') + 1]).toBe('nobody')
      const envFile = call[call.indexOf('--env-file') + 1]!
      expect(readFileSync(envFile, 'utf8')).toBe('X=y\n')
      expect(call.join(' ')).not.toContain('X=y')
      expect(call.slice(call.indexOf('cid0000'))).toEqual(['cid0000', 'sh', '-c', 'cat'])

      const plain = await env.exec(['true'], { timeoutMs: 5000 })
      expect(plain.code).toBe(0)
      const last = fake.calls().at(-1)!
      expect(last).toEqual(['exec', '-i', 'cid0000', 'true'])

      const failed = await env.exec(['--fail'], { timeoutMs: 5000 })
      expect(failed.code).toBe(7)
      expect(failed.stderr).toBe('failed\n')
      // no timeout, no abort: the container is left alone
      expect(fake.calls().map((c) => c[0])).not.toContain('kill')
      await env.dispose()
    } finally {
      restore()
    }
  })

  it('exec: a timeout or an abort ends the client and then kills and starts the container, so the process inside dies too', async () => {
    const root = tempRoot()
    const fake = fakeDocker(root)
    const restore = withPath(fake.bin)
    try {
      const env = (await provider(root).open(spec())) as DockerEnvironment
      const hung = await env.exec(['--hang'], { timeoutMs: 200 })
      expect(hung.code).toBeNull()
      expect(hung.signal).toBeDefined()
      let calls = fake.calls()
      expect(calls.slice(-3)).toEqual([['exec', '-i', 'cid0000', '--hang'], ['kill', 'cid0000'], ['start', 'cid0000']])
      expect(env.notes).toEqual(['exec timed out after 200ms; the container was killed and started again so nothing of it lives on'])

      const controller = new AbortController()
      setTimeout(() => controller.abort(), 100)
      const aborted = await env.exec(['--hang'], { timeoutMs: 10_000, signal: controller.signal })
      expect(aborted.code).toBeNull()
      calls = fake.calls()
      expect(calls.slice(-2)).toEqual([['kill', 'cid0000'], ['start', 'cid0000']])
      expect(env.notes.at(-1)).toBe('exec aborted; the container was killed and started again so nothing of it lives on')

      // dispose mid-exec is not a timeout: rm -f follows, no restart
      const pending = env.exec(['--hang'], { timeoutMs: 10_000 })
      await new Promise((r) => setTimeout(r, 100))
      await env.dispose()
      expect((await pending).code).toBeNull()
      calls = fake.calls()
      expect(calls.at(-1)).toEqual(['rm', '-f', 'cid0000'])
      expect(calls.filter((c) => c[0] === 'kill')).toHaveLength(2)
    } finally {
      restore()
    }
  })

  it('put/get: parents are created, a directory merges into the destination (cp of `/.`), a relative remote path is under the workdir; snapshot commits and inspects; the docker binary is injectable', async () => {
    const root = tempRoot()
    const fake = fakeDocker(root)
    const p = new DockerEnvironmentProvider({ spawn: realSpawn, baseDir: join(root, 'base'), docker: join(fake.bin, 'docker') })
    const env = await p.open(spec({ workdir: '/workspace' }))
    mkdirSync(join(root, 'local-dir'))
    writeFileSync(join(root, 'local-file'), 'x')
    await env.put(join(root, 'local-dir'), '/workspace/in')
    await env.put(join(root, 'local-file'), 'sub/.task/f')
    await env.get('/workspace/out-dir', join(root, 'deep', 'local-out'))
    await env.get('sub/out', join(root, 'deeper', 'still', 'local-rel-out'))
    expect(await env.snapshot!()).toEqual({ ref: 'sha256:snap0000', digest: 'sha256:snap0000' })
    const calls = fake.calls().slice(2)
    expect(calls[0]).toEqual(['exec', 'cid0000', 'mkdir', '-p', '/workspace/in'])
    expect(calls[1]).toEqual(['cp', join(root, 'local-dir') + '/.', 'cid0000:/workspace/in'])
    expect(calls[2]).toEqual(['exec', 'cid0000', 'mkdir', '-p', '/workspace/sub/.task'])
    expect(calls[3]).toEqual(['cp', join(root, 'local-file'), 'cid0000:/workspace/sub/.task/f'])
    expect(calls[4]).toEqual(['exec', 'cid0000', 'test', '-d', '/workspace/out-dir'])
    expect(calls[5]).toEqual(['cp', 'cid0000:/workspace/out-dir/.', join(root, 'deep', 'local-out')])
    expect(calls[6]).toEqual(['exec', 'cid0000', 'test', '-d', '/workspace/sub/out'])
    expect(calls[7]).toEqual(['cp', 'cid0000:/workspace/sub/out', join(root, 'deeper', 'still', 'local-rel-out')])
    expect(existsSync(join(root, 'deep'))).toBe(true)
    expect(existsSync(join(root, 'deeper', 'still'))).toBe(true)
    expect(calls[8]).toEqual(['commit', 'cid0000'])
    expect(calls[9]).toEqual(['image', 'inspect', '--format', '{{.Id}} {{json .RepoDigests}}', 'sha256:snap0000'])
    await env.dispose()
    await expect(env.exec(['true'], { timeoutMs: 100 })).rejects.toThrow(/disposed/)
  })

  it('allowlist runs as none and says so in notes and facts', async () => {
    const root = tempRoot()
    const fake = fakeDocker(root)
    const env = (await new DockerEnvironmentProvider({ spawn: realSpawn, baseDir: join(root, 'base'), docker: join(fake.bin, 'docker') }).open(spec({ network: 'allowlist', allowedHosts: ['example.org'] }))) as DockerEnvironment
    const run = fake.calls()[1]!
    expect(run[run.indexOf('--network') + 1]).toBe('none')
    expect(env.facts().network).toBe('none')
    expect(env.notes).toEqual(['network allowlist is not supported by the docker provider; ran with none'])
    await env.dispose()
  })
})

// ---------------------------------------------------------------- real docker

function dockerAvailable(): string | false {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 20_000 })
    return 'docker'
  } catch {
    return false
  }
}
const realDocker = dockerAvailable()
const REAL_IMAGE = 'alpine:3.20'

describe.skipIf(realDocker === false)('DockerEnvironmentProvider against a real docker daemon (skipped: docker is not on PATH or the daemon is down)', () => {
  it('opens a container, execs with stdin, puts and gets a file, reports the digest, disposes', async () => {
    const root = tempRoot()
    const p = new DockerEnvironmentProvider({ spawn: realSpawn, baseDir: join(root, 'base') })
    const env = await p.open(spec({ image: { ref: REAL_IMAGE }, env: { GREETING: 'hi' }, resources: { timeoutS: 60 } }))
    try {
      expect(env.workdir).toBe('/workspace/att-1')
      const r = await env.exec(['sh', '-c', 'cat; echo "$GREETING"; pwd'], { stdin: 'in\n', timeoutMs: 30_000 })
      expect(r.code).toBe(0)
      expect(r.stdout).toBe('in\nhi\n/workspace/att-1\n')
      writeFileSync(join(root, 'f.txt'), 'payload')
      await env.put(join(root, 'f.txt'), 'f.txt')
      const cat = await env.exec(['cat', '/workspace/att-1/f.txt'], { timeoutMs: 30_000 })
      expect(cat.stdout).toBe('payload')
      await env.exec(['sh', '-c', 'echo out > o.txt'], { timeoutMs: 30_000 })
      await env.get('o.txt', join(root, 'o.txt'))
      expect(readFileSync(join(root, 'o.txt'), 'utf8')).toBe('out\n')
      expect(env.facts().image?.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
      // a directory put onto an existing one merges; a timed-out exec leaves no process behind
      mkdirSync(join(root, 'tree'))
      writeFileSync(join(root, 'tree', 'a.txt'), 'a')
      await env.put(join(root, 'tree'), 'tree')
      await env.put(join(root, 'tree'), 'tree')
      const merged = await env.exec(['ls', '/workspace/att-1/tree'], { timeoutMs: 30_000 })
      expect(merged.stdout).toBe('a.txt\n')
      const hung = await env.exec(['sleep', '30'], { timeoutMs: 1000 })
      expect(hung.code).toBeNull()
      const left = await env.exec(['sh', '-c', 'pgrep -f "sleep 30" || echo none'], { timeoutMs: 30_000 })
      expect(left.stdout).toBe('none\n')
      expect((await env.exec(['cat', 'f.txt'], { timeoutMs: 30_000 })).stdout).toBe('payload')
      const offline = await env.exec(['sh', '-c', 'wget -q -T 3 -O /dev/null http://example.com/ 2>/dev/null; echo $?'], { timeoutMs: 30_000 })
      expect(offline.stdout.trim()).not.toBe('0')
    } finally {
      await env.dispose()
    }
    const gone = await env.exec(['true'], { timeoutMs: 1000 }).catch((e: Error) => e.message)
    expect(gone).toMatch(/disposed/)
  }, 180_000)
})
