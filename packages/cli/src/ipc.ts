import { request } from 'node:http'
import { existsSync } from 'node:fs'

// Talks HTTP over a bridge's unix socket (named pipe on Windows). Plain
// node:http so it runs the same under Node and Bun and stays tiny for hooks.
export function call<T = any>(socket: string, path: string, body?: unknown, timeoutMs = 3000): Promise<T | null> {
  if (process.platform !== 'win32' && !existsSync(socket)) return Promise.resolve(null)
  return new Promise(resolve => {
    const data = body === undefined ? undefined : JSON.stringify(body)
    const req = request(
      {
        socketPath: socket,
        path,
        method: data === undefined ? 'GET' : 'POST',
        headers: data === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
        timeout: timeoutMs,
      },
      res => {
        const chunks: Buffer[] = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => {
          if ((res.statusCode ?? 500) >= 300) return resolve(null)
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T)
          } catch {
            resolve(null)
          }
        })
      },
    )
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(null))
    if (data !== undefined) req.write(data)
    req.end()
  })
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

export async function readStdinJson(): Promise<Record<string, any>> {
  try {
    return JSON.parse((await readStdin()) || '{}')
  } catch {
    return {}
  }
}
