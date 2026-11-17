import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'

export function defaultHome(): string {
  return process.env.QUIETSYNC_HOME || join(homedir(), '.quietsync')
}

// Short and stable: macOS caps unix socket paths near 104 bytes. Windows uses
// a named pipe per user and session instead.
export function socketPathFor(home: string, sessionId: string): string {
  const sid = sessionId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 12)
  if (process.platform === 'win32') {
    const user = (() => {
      try {
        return userInfo().username.replace(/[^A-Za-z0-9_-]/g, '')
      } catch {
        return 'user'
      }
    })()
    return `\\\\.\\pipe\\quietsync-${user}-${sid}`
  }
  const dir = process.env.QUIETSYNC_RUN_DIR || join(home, 'run')
  return join(dir, `${sid}.sock`)
}
