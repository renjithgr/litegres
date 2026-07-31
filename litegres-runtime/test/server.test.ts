import { describe, expect, test } from 'bun:test'
import { ConfigError, parseConfig } from '../src/config'

const SERVER_ENTRYPOINT = new URL('../src/server.ts', import.meta.url).pathname

describe('parseConfig', () => {
  test('applies defaults when no argv[2] is given', () => {
    const config = parseConfig(['bun', 'server.ts'])
    expect(config).toEqual({
      host: '127.0.0.1',
      port: 0,
      database: 'postgres',
      username: 'postgres',
      password: 'postgres',
      dataDir: undefined,
      startupTimeoutMs: 30_000,
      assetsDir: undefined,
    })
  })

  test('applies defaults for an empty JSON object', () => {
    const config = parseConfig(['bun', 'server.ts', '{}'])
    expect(config.host).toBe('127.0.0.1')
    expect(config.port).toBe(0)
  })

  test('reads overrides from argv[2] JSON', () => {
    const config = parseConfig([
      'bun',
      'server.ts',
      JSON.stringify({
        port: 54321,
        database: 'my_db',
        username: 'my_user',
        password: 'my_pass',
        dataDir: '/tmp/pgdata',
        startupTimeoutMs: 5000,
      }),
    ])
    expect(config.port).toBe(54321)
    expect(config.database).toBe('my_db')
    expect(config.username).toBe('my_user')
    expect(config.password).toBe('my_pass')
    expect(config.dataDir).toBe('/tmp/pgdata')
    expect(config.startupTimeoutMs).toBe(5000)
  })

  test('rejects malformed JSON', () => {
    expect(() => parseConfig(['bun', 'server.ts', '{not json'])).toThrow(ConfigError)
  })

  test('rejects a JSON value that is not an object', () => {
    expect(() => parseConfig(['bun', 'server.ts', '[1,2,3]'])).toThrow(ConfigError)
  })

  test('rejects hosts other than 127.0.0.1/localhost', () => {
    expect(() => parseConfig(['bun', 'server.ts', JSON.stringify({ host: '0.0.0.0' })])).toThrow(
      ConfigError,
    )
  })

  test('rejects an out-of-range port', () => {
    expect(() => parseConfig(['bun', 'server.ts', JSON.stringify({ port: 70000 })])).toThrow(
      ConfigError,
    )
    expect(() => parseConfig(['bun', 'server.ts', JSON.stringify({ port: -1 })])).toThrow(
      ConfigError,
    )
  })
})

async function readLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (value) buffer += new TextDecoder().decode(value)
    const newlineIndex = buffer.indexOf('\n')
    if (newlineIndex !== -1) {
      return buffer.slice(0, newlineIndex)
    }
    if (done) {
      throw new Error(`stream closed before a newline was seen; buffered: ${buffer}`)
    }
  }
}

describe('real process: bun run src/server.ts', () => {
  test('starts, reports a ready message, accepts a connection, and shuts down on SIGTERM', async () => {
    const proc = Bun.spawn(['bun', 'run', SERVER_ENTRYPOINT, JSON.stringify({ port: 0 })], {
      stdout: 'pipe',
      stderr: 'pipe',
    })

    try {
      const line = await readLine(proc.stdout as ReadableStream<Uint8Array>)
      const message = JSON.parse(line)

      expect(message.type).toBe('ready')
      expect(message.host).toBe('127.0.0.1')
      expect(typeof message.port).toBe('number')
      expect(message.port).toBeGreaterThan(0)
      expect(message.database).toBe('postgres')
      expect(message.pgliteVersion).toBeTruthy()
      expect(message.postgresVersion).toContain('PostgreSQL')

      const socket = await Bun.connect({
        hostname: '127.0.0.1',
        port: message.port,
        socket: {
          data() {},
          close() {},
          error() {},
        },
      })
      socket.end()

      proc.kill('SIGTERM')
      const exitCode = await proc.exited
      expect(exitCode).toBe(0)
    } finally {
      if (!proc.killed) proc.kill()
    }
  }, 20_000)

  test('shutdown is idempotent under repeated signals', async () => {
    const proc = Bun.spawn(['bun', 'run', SERVER_ENTRYPOINT, JSON.stringify({ port: 0 })], {
      stdout: 'pipe',
      stderr: 'pipe',
    })

    try {
      await readLine(proc.stdout as ReadableStream<Uint8Array>)

      proc.kill('SIGTERM')
      proc.kill('SIGTERM')
      proc.kill('SIGINT')

      const exitCode = await proc.exited
      expect(exitCode).toBe(0)

      const stderrText = await new Response(proc.stderr).text()
      const shutdownCompletions = stderrText.split('shutdown complete').length - 1
      expect(shutdownCompletions).toBe(1)
    } finally {
      if (!proc.killed) proc.kill()
    }
  }, 20_000)

  test('malformed control-plane argument produces an error message and non-zero exit', async () => {
    const proc = Bun.spawn(['bun', 'run', SERVER_ENTRYPOINT, '{not valid json'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const line = await readLine(proc.stdout as ReadableStream<Uint8Array>)
    const message = JSON.parse(line)

    expect(message.type).toBe('error')
    expect(message.message).toContain('Malformed configuration JSON')

    const exitCode = await proc.exited
    expect(exitCode).toBe(1)
  }, 20_000)
})
