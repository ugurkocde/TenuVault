import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
if (process.platform === 'win32') {
  const root = resolve(import.meta.dirname, '..'), folder = mkdtempSync(join(tmpdir(), 'tenuvault-helper-tests-'))
  try {
    const output = join(folder, 'HelperTests.exe')
    const compiler = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
    execFileSync(compiler, ['/nologo','/target:exe','/define:REQUIRE_SIGNATURE','/main:HelperTests',`/win32manifest:${join(root,'native','app-backup','app.manifest')}`,'/r:System.Net.Http.dll','/r:System.Security.dll','/r:System.Web.Extensions.dll',`/out:${output}`,join(root,'native','app-backup','Program.cs'),join(root,'test','native','AppBackupHelperTests.cs')], { stdio: 'inherit' })
    execFileSync(output, [], { stdio: 'inherit', timeout: 10000 })
  } finally { rmSync(folder, { recursive: true, force: true }) }
}
