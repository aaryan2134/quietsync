import { spawnSync } from 'node:child_process'

// The OS keychain, for the identity's private keys: encrypted at rest, locked
// with the login, and out of backups of ~/.quietsync. macOS uses the login
// keychain through `security`; Linux uses the Secret Service through
// `secret-tool`. Secrets go in on stdin, never on a command line.

export type KeyStore = {
  kind: string
  get(account: string): string | null
  set(account: string, secret: string): void
  del(account: string): void
}

const SERVICE = 'quietsync'
const SAFE = /^[A-Za-z0-9_.-]+$/

function run(cmd: string, args: string[], input?: string): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { input, encoding: 'utf8', timeout: 10_000 })
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() }
}

const macos: KeyStore = {
  kind: 'macOS keychain',
  get(account) {
    const r = run('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w'])
    return r.ok && r.out ? r.out : null
  },
  set(account, secret) {
    if (!SAFE.test(account) || !SAFE.test(secret)) throw new Error('keychain values must be plain base64url')
    // `security -i` reads its command from stdin, so the secret isn't in any process's arguments.
    if (!run('security', ['-i'], `add-generic-password -U -s ${SERVICE} -a ${account} -w ${secret}\n`).ok) throw new Error('could not write to the macOS keychain (is it unlocked?)')
  },
  del(account) {
    run('security', ['delete-generic-password', '-s', SERVICE, '-a', account])
  },
}

const secretTool: KeyStore = {
  kind: 'Secret Service',
  get(account) {
    const r = run('secret-tool', ['lookup', 'service', SERVICE, 'account', account])
    return r.ok && r.out ? r.out : null
  },
  set(account, secret) {
    if (!run('secret-tool', ['store', `--label=${SERVICE} ${account}`, 'service', SERVICE, 'account', account], secret).ok) throw new Error('could not write to the Secret Service (is a keyring running?)')
  },
  del(account) {
    run('secret-tool', ['clear', 'service', SERVICE, 'account', account])
  },
}

let override: KeyStore | null | undefined

// For tests: swap in a fake.
export function setKeyStore(k: KeyStore | null | undefined): void {
  override = k
}

// New identities go in the keychain wherever there is one.
export function keychainByDefault(): boolean {
  return !!systemKeyStore()
}

let found: KeyStore | null | undefined

export function systemKeyStore(): KeyStore | null {
  if (override !== undefined) return override
  if (process.env.QUIETSYNC_KEYSTORE === 'file') return null
  if (found === undefined) {
    found =
      process.platform === 'darwin' && spawnSync('which', ['security']).status === 0
        ? macos
        : process.platform === 'linux' && process.env.DBUS_SESSION_BUS_ADDRESS && spawnSync('which', ['secret-tool']).status === 0
          ? secretTool
          : null
  }
  return found
}
