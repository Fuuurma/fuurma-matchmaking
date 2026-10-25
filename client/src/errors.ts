/**
 * Shared error vocabulary for the online client SDK.
 *
 * Server refusals arrive as `{type:"error", code, message}` frames (or HTTP
 * `{error}` bodies) whose wording is the only stable signal until the Worker
 * adopts machine codes everywhere — the one code it does send
 * (`"role-taken"`) is honoured first, message text second. Centralised here
 * so exactly one test pins the coupling (report 3.11 / risk "error-string
 * coupling").
 */

export type ErrorCode =
  | "unavailable"
  | "rate-limited"
  | "queue-full"
  | "ticket-expired"
  | "room-full"
  | "another-tab"
  | "credential"
  | "capability"
  | "role-conflict"
  | "handshake-timeout"
  | "peer-never-arrived"
  | "cancelled"
  | "protocol"

export interface FuurmaErrorOptions {
  terminal?: boolean
  status?: number
  retryAfterSec?: number
}

export class FuurmaError extends Error {
  code: ErrorCode
  /** False when retrying can help (rate limit, blip); true for refusals. */
  terminal: boolean
  status?: number
  retryAfterSec?: number

  constructor(code: ErrorCode, message: string, opts?: FuurmaErrorOptions) {
    super(message)
    this.name = "FuurmaError"
    this.code = code
    this.terminal = opts?.terminal ?? true
    if (opts?.status !== undefined) this.status = opts.status
    if (opts?.retryAfterSec !== undefined) this.retryAfterSec = opts.retryAfterSec
  }
}

/**
 * Map a relay refusal (pre-welcome `error` frame) to an ErrorCode.
 * Prefers the server's machine code when it sends one; falls back to
 * matching the message text. Case-insensitive on the text side.
 */
export function mapRoomRefusal(message: string, code?: string): ErrorCode {
  if (code === "role-taken") return "role-conflict"
  const text = message.toLowerCase()
  if (text.includes("room full") || text.includes("room is full")) return "room-full"
  if (text.includes("another tab")) return "another-tab"
  if (text.includes("credential") || text.includes("legacy slot expired")) return "credential"
  if (text.includes("capability")) return "capability"
  if (text.includes("handshake expired") || text.includes("hello timeout")) {
    return "handshake-timeout"
  }
  if (text.includes("already in use")) return "role-conflict"
  return "protocol"
}

/** Map a matchmaking HTTP failure to an ErrorCode. */
export function mapHttpStatus(status: number): ErrorCode {
  if (status === 429) return "rate-limited"
  if (status === 404 || status === 410) return "ticket-expired"
  if (status === 409) return "queue-full"
  if (status >= 500 || status === 408 || status === 503) return "unavailable"
  if (status >= 400) return "protocol"
  return "unavailable"
}
