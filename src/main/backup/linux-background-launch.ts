import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import type { BackgroundLaunchStatus } from '../../shared/ipc'

const SERVICE = 'tenuvault-background.service'
const TIMER = 'tenuvault-background.timer'
const SESSION = 'graphical-session.target'
const TIMER_CONTENT = `[Unit]
Description=Restart TenuVault for scheduled backups
PartOf=${SESSION}

[Timer]
OnActiveSec=1s
OnCalendar=*:0/5
AccuracySec=1s

[Install]
WantedBy=${SESSION}
`

type Execute = (file: string, args: string[]) => Promise<{ stdout: string }>

async function readIfPresent(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}

function desktopArgument(value: string): string {
  const quoted = value.replace(/[\\"`$]/g, character => `\\${character}`).replace(/%/g, '%%')
  return `"${quoted.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`
}

export class LinuxBackgroundLaunch {
  constructor(private readonly config: string, private readonly executable: string, private readonly execute: Execute) {}

  private get units() { return join(this.config, 'systemd', 'user') }
  private get service() { return join(this.units, SERVICE) }
  private get timer() { return join(this.units, TIMER) }
  private get enabledTimer() { return join(this.units, `${SESSION}.wants`, TIMER) }
  private get autostart() { return join(this.config, 'autostart', 'tenuvault-background.desktop') }
  // Both launchers restrict characters in the executable name. Pass it as a literal argument.
  private get launchArgs() { return ['exec "$@"', 'tenuvault-background', this.executable, '--hidden'] }

  private get serviceContent() {
    // ':' disables systemd's environment substitution. Double '%' escapes unit specifiers.
    const args = this.launchArgs.map(arg => JSON.stringify(arg.replace(/%/g, '%%')))
    return `[Unit]
Description=TenuVault background launch
PartOf=${SESSION}

[Service]
Type=exec
ExecStart=:/bin/sh -c ${args.join(' ')}
`
  }

  private get desktopContent() {
    return `[Desktop Entry]
Type=Application
Name=TenuVault Background
Exec=/bin/sh -c ${this.launchArgs.map(desktopArgument).join(' ')}
Terminal=false
`
  }

  private async systemctl(...args: string[]): Promise<string> {
    return (await this.execute('systemctl', ['--user', ...args])).stdout.trim()
  }

  private probe(...args: string[]): Promise<string | null> {
    return this.systemctl(...args).catch(() => null)
  }

  private session(): Promise<string | null> {
    return this.probe('show', '--property=ActiveState', '--value', SESSION)
  }

  private timerState(): Promise<string | null> {
    return this.probe('show', '--property=UnitFileState,ActiveState', TIMER)
  }

  private timerInstalled(state: string | null): boolean {
    const properties = state?.split('\n') ?? []
    return properties.includes('UnitFileState=enabled') && properties.includes('ActiveState=active')
  }

  private async changeTimer(action: 'enable' | 'disable'): Promise<void> {
    try { await this.systemctl(action, '--now', TIMER) }
    catch (error) { throw new Error(`Could not ${action} the TenuVault background timer in your systemd user session.`, { cause: error }) }
  }

  async status(): Promise<BackgroundLaunchStatus> {
    if (this.timerInstalled(await this.timerState())) return { supported: true, installed: true, mode: 'systemd' }
    if (await readIfPresent(this.autostart) === this.desktopContent) return { supported: true, installed: true, mode: 'autostart' }
    return { supported: true, installed: false }
  }

  private async installTimer(): Promise<BackgroundLaunchStatus> {
    await mkdir(this.units, { recursive: true, mode: 0o700 })
    await writeFile(this.service, this.serviceContent, { mode: 0o600 })
    await writeFile(this.timer, TIMER_CONTENT, { mode: 0o600 })
    // Enabling reloads the unit definitions before starting the timer. An active app stays up.
    await this.changeTimer('enable')
    if (!this.timerInstalled(await this.timerState())) {
      throw new Error('The TenuVault background timer did not start. Check that your app and systemd user session use the same configuration directory (XDG_CONFIG_HOME).')
    }
    await rm(this.autostart, { force: true })
    return { supported: true, installed: true, mode: 'systemd' }
  }

  private async refreshTimer(): Promise<BackgroundLaunchStatus> {
    const [service, timer] = await Promise.all([readIfPresent(this.service), readIfPresent(this.timer)])
    if (service === this.serviceContent && timer === TIMER_CONTENT) return { supported: true, installed: true, mode: 'systemd' }
    try { return await this.installTimer() }
    catch (error) {
      // Retain the previous definitions so the next startup can retry the repair.
      await Promise.all([
        service === null ? rm(this.service, { force: true }) : writeFile(this.service, service, { mode: 0o600 }),
        timer === null ? rm(this.timer, { force: true }) : writeFile(this.timer, timer, { mode: 0o600 }),
      ])
      throw error
    }
  }

  async refresh(): Promise<BackgroundLaunchStatus> {
    const current = await this.status()
    if (current.mode !== 'systemd') return current
    try { return await this.refreshTimer() }
    catch (error) {
      console.warn('Could not refresh the TenuVault background timer.', error)
      return current
    }
  }

  async install(): Promise<BackgroundLaunchStatus> {
    if (!isAbsolute(this.executable)) throw new Error('Background launch requires an absolute application path.')
    const timer = await this.timerState()
    if (this.timerInstalled(timer)) return this.refreshTimer()

    // A desktop must activate the graphical target and export its display to the user manager.
    const session = timer === null ? null : await this.session()
    const environment = session === 'active' ? await this.probe('show-environment') : null
    if (environment && /^(?:DISPLAY|WAYLAND_DISPLAY)=.+/m.test(environment)) return this.installTimer()

    await this.removeUnits(session !== null)
    await mkdir(dirname(this.autostart), { recursive: true, mode: 0o700 })
    await writeFile(this.autostart, this.desktopContent, { mode: 0o600 })
    const status = await this.status()
    if (!status.installed) throw new Error('Could not verify the TenuVault sign-in launcher after installation.')
    return status
  }

  private async removeUnits(managerAvailable: boolean, installed = false): Promise<void> {
    const timerExists = await readIfPresent(this.timer) !== null
    if (!installed && !timerExists && await readIfPresent(this.service) === null) return
    // Stop only the timer. The service may be running an active backup.
    if (managerAvailable && (timerExists || installed)) await this.changeTimer('disable')
    await rm(this.enabledTimer, { force: true })
    await rm(this.timer, { force: true })
    await rm(this.service, { force: true })
    if (managerAvailable) await this.probe('daemon-reload')
  }

  async remove(): Promise<BackgroundLaunchStatus> {
    const timer = await this.timerState()
    await this.removeUnits(timer !== null, this.timerInstalled(timer))
    await rm(this.autostart, { force: true })
    return this.status()
  }
}
