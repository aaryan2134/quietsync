import { spawn } from 'node:child_process'

// A small JSONL stdio client for checking the shipped bundle without installing
// workspace dependencies. It makes no approval decisions for a real user.
export class McpProcess {
  constructor(command, args, { cwd, env = {}, timeout = 8000 } = {}) {
    this.pending = new Map()
    this.sequence = 0
    this.buffer = ''
    this.stderr = ''
    this.timeout = timeout
    this.child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', chunk => {
      this.buffer += chunk
      if (this.buffer.length > 4 * 1024 * 1024) return this.fail(new Error('MCP frame exceeds probe limit'))
      let end
      while ((end = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, end)
        this.buffer = this.buffer.slice(end + 1)
        if (!line.trim()) continue
        let message
        try { message = JSON.parse(line) } catch { this.fail(new Error('MCP server wrote invalid JSON')); return }
        const request = this.pending.get(message.id)
        if (!request) continue
        clearTimeout(request.timer)
        this.pending.delete(message.id)
        if (message.error) request.reject(new Error(JSON.stringify(message.error)))
        else request.resolve(message.result)
      }
    })
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-8000) })
    this.child.on('error', error => this.fail(error))
    this.exited = new Promise(resolve => this.child.on('close', (code, signal) => {
      this.fail(new Error(`MCP process exited (${code ?? signal})`))
      resolve()
    }))
  }

  fail(error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
  }

  request(method, params = {}) {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP request timed out: ${method}`))
      }, this.timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, error => {
        if (!error) return
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  async initialize(name = 'quietsync-probe') {
    const result = await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name, version: '1.0' } })
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    return result
  }

  async close() {
    this.child.stdin.end()
    this.child.kill('SIGTERM')
    const watchdog = setTimeout(() => this.child.kill('SIGKILL'), 2000)
    await this.exited
    clearTimeout(watchdog)
  }
}
