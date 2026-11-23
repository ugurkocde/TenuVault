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

  private async session(): Promise<string | null> {
    try { return await this.systemctl('show', '--property=ActiveState', '--value', SESSION) }
    catch (error) {
      const failure = error as NodeJS.ErrnoException & { stderr?: string }
      if (failure.code === 'ENOENT' || /(?:connect to (?:the )?(?:user |user scope )?bus).*(?:No medium found|No such file|Connection refused|Host is down|Transport endpoint is not connected|\$DBUS_SESSION_BUS_ADDRESS)/i.test(failure.stderr ?? String(error))) return null
      throw error
    }
  }

  async status(): Promise<BackgroundLaunchStatus> {
    if (await readIfPresent(this.service) === this.serviceContent && await readIfPresent(this.timer) === TIMER_CONTENT && await this.session() === 'active') {
      const state = await this.systemctl('show', '--property=UnitFileState,ActiveState', TIMER)
      const properties = state.split('\n')
      if (properties.includes('UnitFileState=enabled') && properties.includes('ActiveState=active')) {
        return { supported: true, installed: true, mode: 'systemd' }
      }
    }
    if (await readIfPresent(this.autostart) === this.desktopContent) return { supported: true, installed: true, mode: 'autostart' }
    return { supported: true, installed: false }
  }

  async install(): Promise<BackgroundLaunchStatus> {
    if (!isAbsolute(this.executable)) throw new Error('Background launch requires an absolute application path.')
    const current = await this.status()
    if (current.installed) return current

    // A desktop must activate the graphical target and export its display to the user manager.
    const session = await this.session()
    const environment = session === 'active' ? await this.systemctl('show-environment') : ''
    if (/^(?:DISPLAY|WAYLAND_DISPLAY)=.+/m.test(environment)) {
      await mkdir(this.units, { recursive: true, mode: 0o700 })
      await writeFile(this.service, this.serviceContent, { mode: 0o600 })
      await writeFile(this.timer, TIMER_CONTENT, { mode: 0o600 })
      // Enabling reloads the unit definitions before starting the timer. An active app stays up.
      await this.systemctl('enable', '--now', TIMER)
      await rm(this.autostart, { force: true })
    } else {
      await this.removeUnits(session)
      await mkdir(dirname(this.autostart), { recursive: true, mode: 0o700 })
      await writeFile(this.autostart, this.desktopContent, { mode: 0o600 })
    }
    return this.status()
  }

  private async removeUnits(session?: string | null): Promise<void> {
    const timerExists = await readIfPresent(this.timer) !== null
    if (!timerExists && await readIfPresent(this.service) === null) return
    const managerAvailable = (session === undefined ? await this.session() : session) !== null
    // Stop only the timer. The service may be running an active backup.
    if (managerAvailable && timerExists) await this.systemctl('disable', '--now', TIMER)
    await rm(this.enabledTimer, { force: true })
    await rm(this.timer, { force: true })
    await rm(this.service, { force: true })
    if (managerAvailable) await this.systemctl('daemon-reload')
  }

  async remove(): Promise<BackgroundLaunchStatus> {
    await this.removeUnits()
    await rm(this.autostart, { force: true })
    return this.status()
  }
}
