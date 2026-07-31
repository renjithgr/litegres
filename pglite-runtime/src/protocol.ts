/**
 * Newline-delimited JSON control protocol written to stdout.
 * stdout is reserved exclusively for these messages — all human-readable
 * diagnostics go to stderr instead.
 */

export interface ReadyMessage {
  type: 'ready'
  host: string
  port: number
  database: string
  username: string
  password: string
  pgliteVersion: string
  postgresVersion: string
}

export interface ErrorMessage {
  type: 'error'
  message: string
  stack?: string
}

export type ControlMessage = ReadyMessage | ErrorMessage

export function sendControlMessage(message: ControlMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}
