import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  const launcher = new BackgroundLaunch({ platform: 'linux', packaged: true, executable: '/app', home: '/unused', data: '/unused', exec })
  await expect(launcher.install()).rejects.toThrow('installed Windows or macOS')
  expect(exec).not.toHaveBeenCalled()
  expect(launchAgent('/Applications/Test.app/Contents/MacOS/Test')).toContain('<integer>300</integer>')
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
