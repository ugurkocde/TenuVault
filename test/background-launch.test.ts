import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { BackgroundLaunch, launchAgent, reopeningLaunchAgent, WINDOWS_TASK } from '../src/main/backup/background-launch'
const programArguments = (plist: string) => [...plist.matchAll(/<string>([^<]*)<\/string>/g)].map(match => match[1]!.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')).slice(1, -1)
it('uses an interactive non-elevated Windows task with login, catch-up and overlap protection', () => {
  expect(WINDOWS_TASK).toContain('-LogonType Interactive -RunLevel Limited')
  expect(WINDOWS_TASK).toContain('-AtLogOn')
  expect(WINDOWS_TASK).toContain('-StartWhenAvailable -MultipleInstances IgnoreNew')
  expect(WINDOWS_TASK).not.toContain('-Password')
})
it('installs and removes a user-session launch agent without interpolating executable text as code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tv-background-'))
  let loaded = false
  const exec = vi.fn(async (_file: string, args: string[]) => {
    if (args[0] === 'print' && !loaded) throw new Error('Could not find service')
    if (args[0] === 'bootstrap') loaded = true
    if (args[0] === 'bootout') loaded = false
    return { stdout: '/usr/bin/open /Applications/A&B.app' }
  })
  const launcher = new BackgroundLaunch({ platform: 'darwin', packaged: true, executable: '/Applications/A&B.app/Contents/MacOS/A&B', home: root, data: root, uid: 501, exec })
  try {
    expect(await launcher.install()).toEqual({ supported: true, installed: true })
    const plist = await readFile(join(root, 'Library/LaunchAgents/com.tenuvault.desktop.background.plist'), 'utf8')
    expect(plist).toContain('A&amp;B')
    expect(plist).toContain('<string>Aqua</string>')
    expect(exec.mock.calls.find(call => call[1][0] === 'bootstrap')).toEqual(['/bin/launchctl', ['bootstrap', 'gui/501', join(root, 'Library/LaunchAgents/com.tenuvault.desktop.background.plist')]])
    loaded = false
    expect(await launcher.status()).toEqual({ supported: true, installed: false })
    expect(await launcher.install()).toEqual({ supported: true, installed: true })
    expect(await launcher.remove()).toEqual({ supported: true, installed: false })
    expect(exec.mock.calls.some(call => call[1][0] === 'bootout')).toBe(true)
    expect(programArguments(plist).slice(0, 2)).toEqual(['/bin/sh', '-c'])
    expect(programArguments(plist)[2]).toContain('exec /usr/bin/open -n -g -j -a "$1" --args --hidden')
    expect(exec.mock.calls.some(call => call[1][0] === 'disable')).toBe(true)
  } finally { await rm(root, { recursive: true, force: true }) }
})
it('does not install on unsupported platforms or development builds', async () => {
  const exec = vi.fn(async () => ({ stdout: '' }))
  const options = { executable: '/app', home: '/unused', data: '/unused', exec }
  for (const launcher of [
    new BackgroundLaunch({ ...options, platform: 'freebsd', packaged: true }),
    new BackgroundLaunch({ ...options, platform: 'linux', packaged: false }),
  ]) {
    await expect(launcher.status()).resolves.toEqual({ supported: false, installed: false })
    await expect(launcher.install()).rejects.toThrow('installed Windows, macOS or Linux')
  }
  expect(exec).not.toHaveBeenCalled()
  expect(launchAgent('/Applications/Test.app/Contents/MacOS/Test')).toContain('<integer>300</integer>')
})

const linuxStatus = { supported: true, installed: true, mode: 'systemd' }
const autostartStatus = { supported: true, installed: true, mode: 'autostart' }
const absentStatus = { supported: true, installed: false }

function linuxSystemctl() {
  const state = {
    session: 'active',
    display: 'WAYLAND_DISPLAY=wayland-0',
    timer: false,
    error: null as Error | null,
    timerError: null as Error | null,
    enableError: null as Error | null,
    enableStartsTimer: true,
  }
  const exec = vi.fn(async (file: string, args: string[]) => {
    expect(file).toBe('systemctl')
    expect(args[0]).toBe('--user')
    if (state.error) throw state.error
    switch (args[1]) {
      case 'show':
        if (args.at(-1) === 'graphical-session.target') return { stdout: state.session }
        if (state.timerError) throw state.timerError
        return { stdout: state.timer ? 'ActiveState=active\nUnitFileState=enabled\n' : 'ActiveState=inactive\nUnitFileState=\n' }
      case 'show-environment': return { stdout: state.display }
      case 'enable':
        if (state.enableError) throw state.enableError
        state.timer = state.enableStartsTimer
        break
      case 'disable': state.timer = false; break
    }
    return { stdout: '' }
  })
  return { state, exec }
}

it('manages a graphical systemd timer and replaces the executable path after moving the app', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tv-background-linux-'))
  const { exec, state } = linuxSystemctl()
  const configHome = join(root, 'custom-config')
  const options = { platform: 'linux' as const, packaged: true, executable: '/opt/TenuVault/tenuvault-desktop', home: root, data: root, configHome, exec }
  const launcher = new BackgroundLaunch(options)
  const service = join(configHome, 'systemd/user/tenuvault-background.service')
  const timer = join(configHome, 'systemd/user/tenuvault-background.timer')
  try {
    expect(await launcher.status()).toEqual(absentStatus)
    expect(await launcher.install()).toEqual(linuxStatus)
    expect(await readFile(service, 'utf8')).toContain(String.raw`ExecStart=:/bin/sh -c "exec \"$@\"" "tenuvault-background" "/opt/TenuVault/tenuvault-desktop" "--hidden"`)
    const timerContents = await readFile(timer, 'utf8')
    expect(timerContents).toContain('PartOf=graphical-session.target')
    expect(timerContents).toContain('WantedBy=graphical-session.target')
    expect(timerContents).toContain('OnActiveSec=1s\nOnCalendar=*:0/5\nAccuracySec=1s')
    expect(await launcher.install()).toEqual(linuxStatus)
    expect(exec.mock.calls.filter(([, args]) => args[1] === 'enable')).toEqual([
      ['systemctl', ['--user', 'enable', '--now', 'tenuvault-background.timer']],
    ])
    state.timer = false
    expect(await launcher.status()).toEqual(absentStatus)
    state.timer = true

    const moved = new BackgroundLaunch({ ...options, executable: '/tmp/.mount_tv/tenuvault-desktop', appImage: '/home/test/TenuVault $v%2 "New".AppImage' })
    await writeFile(timer, 'outdated timer')
    expect(await moved.status()).toEqual(linuxStatus)
    expect(await moved.refresh()).toEqual(linuxStatus)
    expect(await readFile(timer, 'utf8')).toBe(timerContents)
    const updated = await readFile(service, 'utf8')
    expect(updated).toContain(String.raw`"/home/test/TenuVault $v%%2 \"New\".AppImage" "--hidden"`)
    expect(updated).not.toContain('/tmp/.mount_tv')
    expect(await moved.remove()).toEqual(absentStatus)
    expect(await moved.remove()).toEqual(absentStatus)
    expect(exec.mock.calls.filter(([, args]) => ['disable', 'daemon-reload', 'stop'].includes(args[1]!))).toEqual([
      ['systemctl', ['--user', 'disable', '--now', 'tenuvault-background.timer']],
      ['systemctl', ['--user', 'daemon-reload']],
    ])
    await expect(readFile(service)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(timer)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.each(['missing-systemctl', 'missing-bus', 'missing-manager', 'timer-probe-error', 'inactive-session', 'missing-display'])('installs sign-in-only autostart with %s', async reason => {
  const root = await mkdtemp(join(tmpdir(), 'tv-background-xdg-'))
  const { exec, state } = linuxSystemctl()
  if (reason === 'missing-systemctl') state.error = Object.assign(new Error('spawn systemctl ENOENT'), { code: 'ENOENT' })
  if (reason === 'missing-bus') state.error = new Error('Failed to connect to user scope bus via local transport: No medium found')
  if (reason === 'missing-manager') state.error = new Error('Failed to get properties: Process org.freedesktop.systemd1 exited with status 1')
  if (reason === 'timer-probe-error') state.timerError = Object.assign(new Error('Command failed: systemctl'), { stderr: 'Failed to get properties: Operation not permitted' })
  if (reason === 'inactive-session') state.session = 'inactive'
  if (reason === 'missing-display') state.display = 'XDG_CURRENT_DESKTOP=GNOME'
  const options = { platform: 'linux' as const, packaged: true, executable: '/opt/TenuVault/tenuvault-desktop', home: root, data: root, exec }
  const launcher = new BackgroundLaunch({ ...options, appImage: '/home/test/TenuVault=100% $var.AppImage' })
  const entry = join(root, '.config/autostart/tenuvault-background.desktop')
  try {
    expect(await launcher.install()).toEqual(autostartStatus)
    expect(await launcher.status()).toEqual(autostartStatus)
    expect(await launcher.install()).toEqual(autostartStatus)
    expect(await readFile(entry, 'utf8')).toContain(String.raw`"/home/test/TenuVault=100%% \\$var.AppImage" "--hidden"`)
    const moved = new BackgroundLaunch(options)
    expect(await moved.status()).toEqual(absentStatus)
    expect(await moved.install()).toEqual(autostartStatus)
    expect(await readFile(entry, 'utf8')).toContain('"/opt/TenuVault/tenuvault-desktop" "--hidden"')
    expect(await moved.remove()).toEqual(absentStatus)
    expect(await moved.remove()).toEqual(absentStatus)
    expect(exec.mock.calls.some(([, args]) => args[1] === 'enable')).toBe(false)
    await expect(readFile(entry)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('upgrades sign-in-only autostart once the display is available to systemd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tv-background-upgrade-'))
  const { exec, state } = linuxSystemctl()
  const launcher = new BackgroundLaunch({ platform: 'linux', packaged: true, executable: '/app', home: root, data: root, exec })
  const entry = join(root, '.config/autostart/tenuvault-background.desktop')
  try {
    state.display = ''
    expect(await launcher.install()).toEqual(autostartStatus)
    state.display = 'DISPLAY=:0'
    expect(await launcher.install()).toEqual(linuxStatus)
    await expect(readFile(entry)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('reports a failed enable after writing the units and keeps sign-in-only autostart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tv-background-enable-'))
  const { exec, state } = linuxSystemctl()
  const launcher = new BackgroundLaunch({ platform: 'linux', packaged: true, executable: '/app', home: root, data: root, exec })
  try {
    state.display = ''
    expect(await launcher.install()).toEqual(autostartStatus)
    state.display = 'DISPLAY=:0'
    state.enableError = Object.assign(new Error('Command failed: systemctl'), { stderr: 'Operation not permitted' })
    await expect(launcher.install()).rejects.toThrow(/^Could not enable the TenuVault background timer in your systemd user session\.$/)
    expect(await readFile(join(root, '.config/systemd/user/tenuvault-background.timer'), 'utf8')).toContain('OnCalendar=*:0/5')
    expect(await launcher.status()).toEqual(autostartStatus)
    state.enableError = null
    expect(await launcher.install()).toEqual(linuxStatus)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('reports when enable succeeds but the timer is still missing from the user manager', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tv-background-unverified-'))
  const { exec, state } = linuxSystemctl()
  const launcher = new BackgroundLaunch({ platform: 'linux', packaged: true, executable: '/app', home: root, data: root, exec })
  try {
    state.enableStartsTimer = false
    await expect(launcher.install()).rejects.toThrow('The TenuVault background timer did not start.')
    expect(await launcher.status()).toEqual(absentStatus)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.skipIf(process.platform === 'win32')('cleans up the enabled timer after losing the systemd user bus', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tv-background-offline-'))
  const { exec, state } = linuxSystemctl()
  const launcher = new BackgroundLaunch({ platform: 'linux', packaged: true, executable: '/app', home: root, data: root, exec })
  const units = join(root, '.config/systemd/user')
  try {
    expect(await launcher.install()).toEqual(linuxStatus)
    const wants = join(units, 'graphical-session.target.wants')
    await mkdir(wants)
    const enabled = join(wants, 'tenuvault-background.timer')
    await symlink(join(units, 'tenuvault-background.timer'), enabled)
    state.error = new Error('Failed to connect to bus: No such file or directory')
    expect(await launcher.remove()).toEqual(absentStatus)
    expect(await launcher.remove()).toEqual(absentStatus)
    expect(await readdir(wants)).toEqual([])
  } finally { await rm(root, { recursive: true, force: true }) }
})
it('replaces a stale launch helper after the application bundle moves', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tv-background-move-'))
  let loaded: string | null = null
  const exec = vi.fn(async (_file: string, args: string[]) => {
    if (args[0] === 'print') { if (!loaded) throw new Error('Could not find service'); return { stdout: loaded } }
    if (args[0] === 'bootout') loaded = null
    if (args[0] === 'bootstrap') loaded = (await readFile(args[2]!, 'utf8')).replace(/&amp;/g, '&')
    return { stdout: '' }
  })
  const options = { platform: 'darwin' as const, packaged: true, home: root, data: root, uid: 501, exec }
  try {
    await new BackgroundLaunch({ ...options, executable: '/Applications/Old.app/Contents/MacOS/Old' }).install()
    const moved = new BackgroundLaunch({ ...options, executable: '/Applications/New.app/Contents/MacOS/New' })
    expect((await moved.status()).installed).toBe(false)
    expect((await moved.install()).installed).toBe(true)
    expect(exec.mock.calls.filter(call => call[1][0] === 'bootout')).toHaveLength(1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('removes a legacy direct-launch agent without terminating its running app', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tv-background-legacy-'))
  const plist = join(root, 'Library/LaunchAgents/com.tenuvault.desktop.background.plist')
  const exec = vi.fn(async (_file: string, _args: string[]) => ({ stdout: '/Applications/Old.app/Contents/MacOS/Old' }))
  const launcher = new BackgroundLaunch({ platform: 'darwin', packaged: true, executable: '/Applications/New.app/Contents/MacOS/New', home: root, data: root, uid: 501, exec })
  try {
    await mkdir(join(root, 'Library/LaunchAgents'), { recursive: true })
    await writeFile(plist, 'legacy direct-launch definition')
    expect((await launcher.status()).installed).toBe(true)
    // Installing over the still-loaded legacy agent surfaces the remove-first
    // guidance instead of silently reporting the old agent as installed.
    await expect(launcher.install()).rejects.toThrow('before reinstalling')
    expect((await launcher.remove()).installed).toBe(false)
    await expect(readFile(plist)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(exec.mock.calls).toContainEqual(['/bin/launchctl', ['disable', 'gui/501/com.tenuvault.desktop.background']])
    expect(exec.mock.calls).not.toContainEqual(['/bin/launchctl', ['bootout', 'gui/501/com.tenuvault.desktop.background']])
    await expect(launcher.install()).rejects.toThrow('before reinstalling')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('passes the bundle and executable to the helper as arguments instead of script text', () => {
  const args = programArguments(launchAgent('/Applications/A"$(x)&B.app/Contents/MacOS/A"$(x)&B'))
  expect(args[2]).toBe(programArguments(launchAgent('/Applications/TenuVault.app/Contents/MacOS/TenuVault'))[2])
  expect(args.slice(3)).toEqual(['tenuvault-background', '/Applications/A"$(x)&B.app', '/Applications/A"$(x)&B.app/Contents/MacOS/A"$(x)&B'])
  expect(programArguments(reopeningLaunchAgent('/Applications/A&B.app/Contents/MacOS/A&B'))).toEqual(['/usr/bin/open', '-g', '-j', '-a', '/Applications/A&B.app', '--args', '--hidden'])
})
it.runIf(process.platform === 'darwin')('opens the app only when no process of this user runs its executable', async () => {
  const run = promisify(execFile)
  const script = programArguments(launchAgent('/Applications/TenuVault.app/Contents/MacOS/TenuVault'))[2]!
  // The bundle does not exist, so the helper fails exactly when it calls open.
  const running = spawn('/bin/sleep', ['30'])
  try {
    await once(running, 'spawn')
    await expect(run('/bin/sh', ['-c', script, 'tenuvault-background', '/nonexistent/Missing.app', '/bin/sleep'])).resolves.toBeDefined()
  } finally { running.kill() }
  await expect(run('/bin/sh', ['-c', script, 'tenuvault-background', '/nonexistent/Missing.app', '/nonexistent/Missing.app/Contents/MacOS/Missing'])).rejects.toThrow()
})
it('replaces the reopening agent of an earlier build at startup and leaves other agents alone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tv-background-refresh-'))
  const file = join(root, 'Library/LaunchAgents/com.tenuvault.desktop.background.plist')
  const executable = '/Applications/TenuVault.app/Contents/MacOS/TenuVault'
  let loaded: string | null = null
  const exec = vi.fn(async (_file: string, args: string[]) => {
    if (args[0] === 'print') { if (loaded === null) throw new Error('Could not find service'); return { stdout: programArguments(loaded).join(' ') } }
    if (args[0] === 'bootout') loaded = null
    if (args[0] === 'bootstrap') loaded = await readFile(args[2]!, 'utf8')
    return { stdout: '' }
  })
  const launcher = new BackgroundLaunch({ platform: 'darwin', packaged: true, executable, home: root, data: root, uid: 501, exec })
  try {
    expect(await launcher.refresh()).toEqual({ supported: true, installed: false })
    await mkdir(join(root, 'Library/LaunchAgents'), { recursive: true })
    loaded = reopeningLaunchAgent('/Applications/Old.app/Contents/MacOS/Old')
    await writeFile(file, loaded)
    expect(await launcher.refresh()).toEqual({ supported: true, installed: false })
    expect(exec.mock.calls.some(call => ['bootout', 'bootstrap'].includes(call[1][0]!))).toBe(false)
    loaded = reopeningLaunchAgent(executable)
    await writeFile(file, loaded)
    expect(await launcher.refresh()).toEqual({ supported: true, installed: true })
    expect(await readFile(file, 'utf8')).toBe(launchAgent(executable))
    expect(exec.mock.calls.filter(call => call[1][0] === 'bootout')).toHaveLength(1)
    expect(await launcher.refresh()).toEqual({ supported: true, installed: true })
    expect(exec.mock.calls.filter(call => call[1][0] === 'bootstrap')).toHaveLength(1)
  } finally { await rm(root, { recursive: true, force: true }) }
})
it('retries a bootstrap that launchd refuses right after the bootout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tv-background-retry-'))
  const executable = '/Applications/TenuVault.app/Contents/MacOS/TenuVault'
  let loaded: string | null = reopeningLaunchAgent(executable), refused = false
  const exec = vi.fn(async (_file: string, args: string[]) => {
    if (args[0] === 'print') { if (loaded === null) throw new Error('Could not find service'); return { stdout: programArguments(loaded).join(' ') } }
    if (args[0] === 'bootout') loaded = null
    if (args[0] === 'bootstrap') { if (!refused) { refused = true; throw new Error('Bootstrap failed: 5: Input/output error') } loaded = await readFile(args[2]!, 'utf8') }
    return { stdout: '' }
  })
  try {
    await mkdir(join(root, 'Library/LaunchAgents'), { recursive: true })
    await writeFile(join(root, 'Library/LaunchAgents/com.tenuvault.desktop.background.plist'), loaded)
    expect(await new BackgroundLaunch({ platform: 'darwin', packaged: true, executable, home: root, data: root, uid: 501, exec }).refresh()).toEqual({ supported: true, installed: true })
    expect(exec.mock.calls.filter(call => call[1][0] === 'bootstrap')).toHaveLength(2)
  } finally { await rm(root, { recursive: true, force: true }) }
})
it('restores the earlier agent when the replacement cannot be loaded and replaces it on the next start', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tv-background-restore-'))
  const file = join(root, 'Library/LaunchAgents/com.tenuvault.desktop.background.plist')
  const executable = '/Applications/TenuVault.app/Contents/MacOS/TenuVault'
  let loaded: string | null = reopeningLaunchAgent(executable), refusals = 2
  const exec = vi.fn(async (_file: string, args: string[]) => {
    if (args[0] === 'print') { if (loaded === null) throw new Error('Could not find service'); return { stdout: programArguments(loaded).join(' ') } }
    if (args[0] === 'bootout') loaded = null
    if (args[0] === 'bootstrap') {
      const content = await readFile(args[2]!, 'utf8')
      if (content === launchAgent(executable) && refusals-- > 0) throw new Error('Bootstrap failed: 5: Input/output error')
      loaded = content
    }
    return { stdout: '' }
  })
  const launcher = new BackgroundLaunch({ platform: 'darwin', packaged: true, executable, home: root, data: root, uid: 501, exec })
  try {
    await mkdir(join(root, 'Library/LaunchAgents'), { recursive: true })
    await writeFile(file, loaded)
    await expect(launcher.refresh()).rejects.toThrow('Bootstrap failed')
    expect(await readFile(file, 'utf8')).toBe(reopeningLaunchAgent(executable))
    expect(loaded).toBe(reopeningLaunchAgent(executable))
    expect(await launcher.refresh()).toEqual({ supported: true, installed: true })
    expect(await readFile(file, 'utf8')).toBe(launchAgent(executable))
  } finally { await rm(root, { recursive: true, force: true }) }
})
