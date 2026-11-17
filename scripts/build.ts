import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'

// The CLI, bridge and hook run on Node 22+ or Bun. The relay needs Bun (it
// uses Bun's WebSocket server and SQLite), so it's its own file the CLI loads
// only for `quietsync relay`.
const builds = [
  { entry: 'packages/cli/src/main.ts', name: 'quietsync.mjs', target: 'node', banner: '#!/usr/bin/env node' },
  { entry: 'packages/cli/src/hook.ts', name: 'hook.mjs', target: 'node', banner: '#!/usr/bin/env node' },
  { entry: 'packages/relay/src/index.ts', name: 'relay.mjs', target: 'bun', banner: '' },
] as const

rmSync('packages/cli/dist', { recursive: true, force: true })
rmSync('plugins/claude-code/dist', { recursive: true, force: true })
mkdirSync('plugins/claude-code/dist', { recursive: true })
for (const b of builds) {
  const res = await Bun.build({
    entrypoints: [b.entry],
    target: b.target,
    format: 'esm',
    outdir: 'packages/cli/dist',
    naming: b.name,
    external: ['@quietsync/relay'],
    minify: { syntax: true, whitespace: false, identifiers: false },
  })
  if (!res.success) {
    for (const l of res.logs) console.error(l)
    process.exit(1)
  }
  const out = `packages/cli/dist/${b.name}`
  if (b.banner) await Bun.write(out, `${b.banner}\n${(await Bun.file(out).text()).replace(/^#!.*\n/, '')}`)
  chmodSync(out, 0o755)
  copyFileSync(out, `plugins/claude-code/dist/${b.name}`)
}
// Licenses of the third-party code that ends up inside the bundles.
const bundled = new Set<string>()
for (const b of builds) {
  const text = await Bun.file(`packages/cli/dist/${b.name}`).text()
  for (const m of text.matchAll(/node_modules\/\.bun\/([^/\s]+)\/node_modules\/((?:@[^/\s]+\/)?[^/\s]+)/g)) bundled.add(`${m[1]}|${m[2]}`)
}
const notices: string[] = ['# Third-party notices', '', 'These packages are bundled into the files in this folder.', '']
for (const entry of [...bundled].sort()) {
  const [store, name] = entry.split('|') as [string, string]
  const dir = `node_modules/.bun/${store}/node_modules/${name}`
  const pkg = JSON.parse(await Bun.file(`${dir}/package.json`).text()) as { version: string; license?: string }
  const licenseFile = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'LICENCE'].map(f => `${dir}/${f}`).find(f => existsSync(f))
  notices.push(`## ${name} ${pkg.version} (${pkg.license ?? 'see package'})`, '', licenseFile ? (await Bun.file(licenseFile).text()).trim() : '(no license file shipped)', '')
}
await Bun.write('packages/cli/dist/THIRD_PARTY_NOTICES.md', `${notices.join('\n').trimEnd()}\n`)
copyFileSync('packages/cli/dist/THIRD_PARTY_NOTICES.md', 'plugins/claude-code/dist/THIRD_PARTY_NOTICES.md')

copyFileSync('packages/cli/assets/hook.sh', 'packages/cli/dist/hook.sh')
copyFileSync('packages/cli/assets/hook.sh', 'plugins/claude-code/dist/hook.sh')
chmodSync('plugins/claude-code/dist/hook.sh', 0o755)
console.log(`built ${builds.map(b => b.name).join(', ')} into packages/cli/dist and plugins/claude-code/dist`)
