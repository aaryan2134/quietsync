#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = path => readFileSync(resolve(root, path), 'utf8')
const json = path => JSON.parse(read(path))
const fail = message => { throw new Error(message) }
const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))]

for (const file of files.filter(file => file.endsWith('.json'))) json(file)
const version = /VERSION = '([^']+)'/.exec(read('packages/cli/src/version.ts'))?.[1]
for (const file of ['packages/core/package.json', 'packages/cli/package.json', 'packages/relay/package.json', 'plugins/claude-code/.claude-plugin/plugin.json', 'plugins/claude-code-ui/.claude-plugin/plugin.json']) {
  if (json(file).version !== version) fail(`Version mismatch: ${file}`)
}
const bun = read('.bun-version').trim()
if (json('package.json').packageManager !== `bun@${bun}`) fail('Bun pin differs from packageManager')
for (const file of files.filter(file => file.endsWith('.md'))) {
  for (const match of read(file).matchAll(/!?\[[^\]]*\]\(([^\s)]+)\)/g)) {
    const target = match[1]
    if (/^(?:[a-z]+:|#)/i.test(target)) continue
    const path = target.split('#')[0]
    if (path && !existsSync(resolve(root, dirname(file), path))) fail(`Missing link target in ${file}: ${target}`)
  }
}
for (const file of files.filter(file => file.startsWith('.github/workflows/') && file.endsWith('.yml'))) {
  for (const match of read(file).matchAll(/\buses:\s+([^\s#]+)/g)) {
    if (!match[1].startsWith('./') && !/@[a-f0-9]{40}$/.test(match[1])) fail(`Unpinned action in ${file}: ${match[1]}`)
  }
}
console.log(`Repository checks passed: ${files.length} files, version ${version}, Bun ${bun}, local Markdown targets and workflow action pins.`)
