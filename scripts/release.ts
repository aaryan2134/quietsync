// Builds a release folder: the plugin bundle people install from, standalone
// binaries, and checksums. Nothing is uploaded or committed.
//   bun run release                 all platforms
//   RELEASE_TARGETS=darwin-arm64 bun run release
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, createReadStream, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { VERSION } from '../packages/cli/src/version.ts'

const ALL = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'windows-x64']
const targets = (process.env.RELEASE_TARGETS ?? ALL.join(',')).split(',').filter(Boolean)
const out = join('release', VERSION)
const name = `quietsync-${VERSION}`
const bundle = join(out, name)

function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed`)
}

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
run('bun', ['run', 'build'])

// The folder people unpack and point Claude Code at.
mkdirSync(join(bundle, 'bin'), { recursive: true })
cpSync('.claude-plugin', join(bundle, '.claude-plugin'), { recursive: true })
cpSync('plugins', join(bundle, 'plugins'), { recursive: true, filter: src => !src.includes(`${join('.claude-plugin', 'types')}`) && !src.endsWith('.DS_Store') })
// The demo video and screenshots stay on GitHub; the bundle is for installing.
cpSync('docs', join(bundle, 'docs'), { recursive: true, filter: src => !src.includes(join('docs', 'media')) })
mkdirSync(join(bundle, 'scripts'), { recursive: true })
for (const f of ['client-config.mjs', 'probe-clients.mjs']) cpSync(join('scripts', f), join(bundle, 'scripts', f))
for (const f of ['README.md', 'SETUP.md', 'LICENSE', 'NOTICE', 'CHANGELOG.md', 'SECURITY.md']) cpSync(f, join(bundle, f))
for (const f of ['quietsync', 'start-relay']) {
  cpSync(join('scripts', 'bundle', f), join(bundle, 'bin', f))
  chmodSync(join(bundle, 'bin', f), 0o755)
}
run('tar', ['-czf', join(out, `${name}.tar.gz`), '-C', out, name])

// Standalone binaries: CLI and relay in one file, no Node or Bun needed.
for (const t of targets) {
  const file = join(out, `${name}-${t}${t.startsWith('windows') ? '.exe' : ''}`)
  run('bun', ['build', 'packages/cli/src/main.ts', '--compile', `--target=bun-${t}`, '--outfile', file])
}

const sums: string[] = []
for (const f of readdirSync(out).sort()) {
  if (!statSync(join(out, f)).isFile()) continue
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => createReadStream(join(out, f)).on('data', d => hash.update(d)).on('end', resolve).on('error', reject))
  sums.push(`${hash.digest('hex')}  ${f}`)
}
writeFileSync(join(out, 'SHA256SUMS'), `${sums.join('\n')}\n`)
console.log(`\nrelease ${VERSION} in ${out}:\n${sums.map(s => `  ${s.split('  ')[1]}`).join('\n')}`)
