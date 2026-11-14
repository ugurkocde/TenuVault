import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
export function buildAppBackupHelper() {
  if (process.platform !== 'win32') return
  const root = resolve(import.meta.dirname, '..')
  mkdirSync(join(root, 'out', 'helper'), { recursive: true })
  const compiler = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  execFileSync(compiler, ['/nologo', '/target:exe', '/platform:anycpu', '/optimize+', `/win32manifest:${join(root,'native','app-backup','app.manifest')}`, ...(process.env.TENUVAULT_RELEASE_BUILD === '1' ? ['/define:REQUIRE_SIGNATURE'] : []), '/r:System.Net.Http.dll', '/r:System.Security.dll', '/r:System.Web.Extensions.dll', `/out:${join(root,'out','helper','TenuVault.Capture.exe')}`, join(root,'native','app-backup','Program.cs')], { stdio: 'inherit' })
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) buildAppBackupHelper()
