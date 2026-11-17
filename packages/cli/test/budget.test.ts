import { expect, test } from 'bun:test'
import { INSTRUCTIONS, TOOLS } from '../src/tools.ts'

// Every Claude Code session carries these whether or not it ever links, so they stay small.
test('what every session loads stays under budget', () => {
  expect(INSTRUCTIONS.length).toBeLessThan(1000)
  expect(JSON.stringify(TOOLS).length).toBeLessThan(6000)
  expect(JSON.stringify(TOOLS.filter(t => t.name !== 'quietsync_setup')).length + INSTRUCTIONS.length).toBeLessThan(6500)
})
