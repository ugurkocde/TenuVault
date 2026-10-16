import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
const run = promisify(execFile)
const LABEL = 'com.tenuvault.desktop.background'
const xml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
const plist = (args: string[]) => `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${LABEL}</string><key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>StartInterval</key><integer>300</integer><key>LimitLoadToSessionType</key><string>Aqua</string></dict></plist>`
const bundleOf = (executable: string) => {
  const bundle = dirname(dirname(dirname(executable)))
  if (!bundle.endsWith('.app')) throw new Error('Background launch requires a macOS application bundle')
  return bundle
}
// Opening a running app sends it a reopen event, which shows and focuses the window like a dock click.
// The helper skips the launch while this user runs the executable, and otherwise opens a new instance:
// if TenuVault started in the meantime or the check missed it, that instance loses the single-instance
// lock and exits, and the running app ignores its --hidden arguments instead of coming to the front.
const OPEN_IF_NOT_RUNNING = '/bin/ps -U "$(/usr/bin/id -u)" -o comm= | /usr/bin/grep -Fxq -- "$2" || exec /usr/bin/open -n -g -j -a "$1" --args --hidden'
export function launchAgent(executable: string): string {
  return plist(['/bin/sh', '-c', OPEN_IF_NOT_RUNNING, 'tenuvault-background', bundleOf(executable), executable])
}
/** The agent of earlier builds, which reopened TenuVault every five minutes even while it was running. */
export function reopeningLaunchAgent(executable: string): string {
  return plist(['/usr/bin/open', '-g', '-j', '-a', bundleOf(executable), '--args', '--hidden'])
}
export const WINDOWS_TASK = `param([ValidateSet('status','install','remove')][string]$Operation, [string]$AppPath)
$ErrorActionPreference = 'Stop'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$name = 'TenuVault Background ' + $identity.User.Value
$existing = Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -eq $name }
if ($Operation -eq 'status') { if ($existing) { 'installed' } else { 'absent' }; exit 0 }
if ($Operation -eq 'remove') { if ($existing) { Unregister-ScheduledTask -TaskName $name -Confirm:$false }; exit 0 }
if (-not [System.IO.Path]::IsPathRooted($AppPath) -or -not (Test-Path -LiteralPath $AppPath)) { throw 'Invalid application path' }
$action = New-ScheduledTaskAction -Execute $AppPath -Argument '--hidden'
$login = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
$periodic = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $name -Action $action -Trigger @($login,$periodic) -Principal $principal -Settings $settings -Force | Out-Null
`
interface Options { platform: NodeJS.Platform; packaged: boolean; executable: string; home: string; data: string; uid?: number; systemRoot?: string; exec?: (file: string, args: string[]) => Promise<{ stdout: string }> }
export class BackgroundLaunch {
  constructor(private readonly options: Options) {}
  private execute(file: string, args: string[]) { return (this.options.exec ?? ((command, params) => run(command, params, { timeout: 30_000 })))(file, args) }
  private get supported() { return this.options.packaged && ['win32', 'darwin'].includes(this.options.platform) }
  private get plist() { return join(this.options.home, 'Library', 'LaunchAgents', `${LABEL}.plist`) }
  private async windows(operation: string): Promise<string> {
    const script = join(this.options.data, 'background-launch.ps1')
    await mkdir(this.options.data, { recursive: true, mode: 0o700 })
    await writeFile(script, WINDOWS_TASK, { mode: 0o600 })
    const result = await this.execute(join(this.options.systemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Operation', operation, '-AppPath', this.options.executable])
    return result.stdout.trim()
  }
  private async service(): Promise<string | null> {
    try { return (await this.execute('/bin/launchctl', ['print', `gui/${this.options.uid}/${LABEL}`])).stdout }
    catch (error) { if (/Could not find service|No such process/i.test(String(error))) return null; throw error }
  }
  private async unload(): Promise<void> {
    const service = await this.service()
    if (service === null) return
    // Only the short-lived open helper belongs to this service, never the app.
    if (!service.includes('/usr/bin/open')) throw new Error('An older direct-launch agent is loaded. Remove background launch first, then log out and back in before reinstalling; active backups are left running.')
    await this.execute('/bin/launchctl', ['bootout', `gui/${this.options.uid}/${LABEL}`])
  }
  async status(): Promise<{ supported: boolean; installed: boolean }> {
    if (!this.supported) return { supported: false, installed: false }
    if (this.options.platform === 'win32') return { supported: true, installed: (await this.windows('status')) === 'installed' }
    try { const plist = await readFile(this.plist, 'utf8'), service = await this.service(); return { supported: true, installed: !!service && (!service.includes('/usr/bin/open') || (plist === launchAgent(this.options.executable) && service.includes(dirname(dirname(dirname(this.options.executable)))))) } }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { supported: true, installed: false }; throw error }
  }
  /** Checks the status and replaces an agent of an earlier build that brought the window to the front. */
  async refresh(): Promise<{ supported: boolean; installed: boolean }> {
    if (this.supported && this.options.platform === 'darwin') {
      const current = await readFile(this.plist, 'utf8').catch(() => null)
      if (current === reopeningLaunchAgent(this.options.executable) && (await this.service())?.includes('/usr/bin/open')) {
        try { return await this.install() }
        catch (error) {
          // Put the earlier agent back so restarts keep working and the next start tries again.
          await writeFile(this.plist, current, { mode: 0o600 })
          await this.execute('/bin/launchctl', ['bootstrap', `gui/${this.options.uid}`, this.plist]).catch(() => undefined)
          throw error
        }
      }
    }
    return this.status()
  }
  async install(): Promise<{ supported: boolean; installed: boolean }> {
    if (!this.supported) throw new Error('Background launch requires an installed Windows or macOS build.')
    if (this.options.platform === 'win32') await this.windows('install')
    else {
      const domain = `gui/${this.options.uid}`
      if ((await this.status()).installed) return { supported: true, installed: true }
      await this.unload()
      await mkdir(join(this.options.home, 'Library', 'LaunchAgents'), { recursive: true, mode: 0o700 })
      await writeFile(this.plist, launchAgent(this.options.executable), { mode: 0o600 })
      try {
        await this.execute('/bin/launchctl', ['enable', `${domain}/${LABEL}`])
        // launchd can refuse a bootstrap right after the bootout of the same label, so try once more.
        const bootstrap = () => this.execute('/bin/launchctl', ['bootstrap', domain, this.plist])
        await bootstrap().catch(async () => { await new Promise(resolve => setTimeout(resolve, 1_000)); return bootstrap() })
      }
      catch (error) { await rm(this.plist, { force: true }); throw error }
    }
    return this.status()
  }
  async remove(): Promise<{ supported: boolean; installed: boolean }> {
    if (!this.supported) throw new Error('Background launch is unavailable on this platform.')
    if (this.options.platform === 'win32') await this.windows('remove')
    else {
      const service = await this.service()
      // Legacy agents own the running app: disable future loads without killing it.
      if (service === null || service.includes('/usr/bin/open')) await this.unload()
      await this.execute('/bin/launchctl', ['disable', `gui/${this.options.uid}/${LABEL}`])
      await rm(this.plist, { force: true })
    }
    return this.status()
  }
}
