import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
const script = resolve(import.meta.dirname, '../scripts/check-fuses.cjs')

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(wire: Buffer) {
  const root = mkdtempSync(join(tmpdir(), 'tv-fuses-'))
  roots.push(root)
  const binary = join(root, 'electron-binary')
  writeFileSync(binary, Buffer.concat([
    Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'),
    Buffer.from([1, wire.length]),
    wire,
  ]))
  return binary
}

function check(...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
}

describe('packaged security fuse check', () => {
  it('loads the dependency and prints usage without an app argument', () => {
    const result = check()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Usage: node scripts/check-fuses.cjs')
  })

  it('accepts a binary with all six security fuses configured', () => {
    const result = check(fixture(Buffer.from('00001100')))
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('All six security fuses verified')
  })

  it.each([
    ['RunAsNode', 0],
    ['EnableNodeOptionsEnvironmentVariable', 2],
    ['EnableNodeCliInspectArguments', 3],
    ['EnableEmbeddedAsarIntegrityValidation', 4],
    ['OnlyLoadAppFromAsar', 5],
    ['GrantFileProtocolExtraPrivileges', 7],
  ] as const)('rejects an unexpected state for %s', (name, index) => {
    const wire = Buffer.from('00001100')
    wire[index] = wire[index] === 48 ? 49 : 48
    const result = check(fixture(wire))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`Unexpected fuse: ${name}`)
  })

  it('rejects a binary without a fuse wire', () => {
    const binary = fixture(Buffer.from('00001100'))
    writeFileSync(binary, 'not an Electron binary')
    const result = check(binary)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Could not find sentinel')
  })
})
