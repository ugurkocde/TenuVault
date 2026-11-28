import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const dir = await mkdtemp(join(tmpdir(), 'tv-measure-script-'))
try {
  const outfile = join(dir, 'measure.mjs')
  await build({
    entryPoints: ['scripts/measure-large-backup.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    define: { __TV_LAB_EXPANDED_ENTRA__: JSON.stringify(process.env.TV_MEASURE_DIRECTORY === '1') },
  })
  await import(pathToFileURL(outfile).href)
} finally { await rm(dir, { recursive: true, force: true }) }
