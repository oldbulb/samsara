import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToolArgsError, type ToolRunContext } from '@oldbulb/samsara-kernel'
import { createSubmitTool, readSubmit, submitFileInstruction, submitInstruction } from '../src/index.ts'

const schema = {
  type: 'object',
  properties: { answer: { type: 'string' }, score: { type: 'number' } },
  required: ['answer'],
  additionalProperties: false,
}

const dirs: string[] = []
function workdir() {
  const d = mkdtempSync(join(tmpdir(), 'samsara-submit-'))
  dirs.push(d)
  return d
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function fakeExec() {
  const exec = { callId: 'call-1', signal: new AbortController().signal, concludeTurn: vi.fn() }
  return exec as unknown as ToolRunContext & { concludeTurn: ReturnType<typeof vi.fn> }
}

describe('createSubmitTool', () => {
  it('has the structured-output shape', () => {
    const tool = createSubmitTool({ name: 'submit', schema, workdir: workdir() })
    expect(tool.name).toBe('submit')
    expect(tool.parameters).toBe(schema)
    expect(tool.output.schema).toMatchObject({ required: ['recorded'] })
    expect(tool.output.render({ recorded: true } as never, {} as never)).toEqual([{ type: 'text', text: 'Result recorded.' }])
  })

  it('valid args: writes <name>.json atomically, calls onSubmit and concludeTurn', async () => {
    const wd = workdir()
    const onSubmit = vi.fn()
    const tool = createSubmitTool({ name: 'submit', schema, workdir: wd, onSubmit })
    const exec = fakeExec()
    await expect(tool.execute({ answer: 'x', score: 1 }, exec)).resolves.toEqual({ recorded: true })
    expect(JSON.parse(readFileSync(join(wd, 'submit.json'), 'utf8'))).toEqual({ answer: 'x', score: 1 })
    expect(readdirSync(wd)).toEqual(['submit.json'])
    expect(onSubmit).toHaveBeenCalledWith({ answer: 'x', score: 1 })
    expect(exec.concludeTurn).toHaveBeenCalledTimes(1)
  })

  it('invalid args: throws ToolArgsError, writes nothing, does not conclude', async () => {
    const wd = workdir()
    const tool = createSubmitTool({ name: 'submit', schema, workdir: wd })
    const exec = fakeExec()
    let err: unknown
    try { await tool.execute({ score: 'no' }, exec) } catch (e) { err = e }
    expect(err).toBeInstanceOf(ToolArgsError)
    expect((err as ToolArgsError).violations.length).toBeGreaterThan(0)
    expect(existsSync(join(wd, 'submit.json'))).toBe(false)
    expect(exec.concludeTurn).not.toHaveBeenCalled()
  })
})

describe('readSubmit', () => {
  it('round-trips value and sha256 of the file bytes', async () => {
    const wd = workdir()
    await createSubmitTool({ name: 'out', schema, workdir: wd }).execute({ answer: 'y' }, fakeExec())
    const rec = readSubmit(wd, 'out')
    expect(rec?.value).toEqual({ answer: 'y' })
    expect(rec?.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(readSubmit(wd, 'out')?.sha256).toBe(rec?.sha256)
  })
  it('is undefined when nothing was submitted', () => {
    expect(readSubmit(workdir(), 'out')).toBeUndefined()
  })
})

describe('instructions', () => {
  it('name the tool / the file and embed the schema', () => {
    expect(submitInstruction('submit', schema)).toContain('`submit` tool')
    expect(submitInstruction('submit', schema)).toContain('"answer"')
    expect(submitFileInstruction('submit', schema)).toContain('`submit.json`')
    expect(submitFileInstruction('submit', schema)).toContain('working directory')
  })
})
