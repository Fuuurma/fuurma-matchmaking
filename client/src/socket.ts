/**
 * RoomSocket — Durable-Object WebSocket relay client for two-player rooms.
 *
 * Merge of T's `room.ts` state machine (attempt supersession, handshake
 * deadline, single-settle, F253 error capture, F748 welcome validation,
 * F151/F37/F746 reconnect correctness) with G's additions (slotToken
 * persistence, `closeForReconnect` 4000/"reconnecting" recycle signature,
 * denied-storage survival), minus what the report drops: no heartbeat, no
 * outbound rate limit, no size caps (the server owns 64 KiB), no `protocol`
 * envelope field, no `autoReconnect: false` dual-mode.
 *
 * One reconnect loop with a budget (default 6 attempts, 800 ms doubling to
 * 8 s ≈ 28 s against the server's 30 s grace). No DOM, no React, no Zod:
 * the socket, storage, and (in matchmaking.ts) fetch are injected.
 */

import { FuurmaError, mapRoomRefusal } from "./errors"
import type { StorageLike } from "./identity"

export type RoomRole = "host" | "guest"

export interface PeerProfile {
  guestId: string
  displayName: string
}

export interface WelcomeMessage {
  type: "welcome"
  role: RoomRole
  opponent: PeerProfile | null
  reconnectToken?: string
}

export interface PeerJoinedMessage {
  type: "peer-joined"
  opponent: PeerProfile
}

export interface PeerReconnectedMessage {
  type: "peer-reconnected"
  opponent: PeerProfile
}

export interface PeerLeftMessage {
  type: "peer-left"
  reason: "disconnect" | "closed" | "expired"
}

export interface RelayErrorMessage {
  type: "error"
  code: string
  message: string
}

export type RoomEnvelope =
  | WelcomeMessage
  | PeerJoinedMessage
  | PeerReconnectedMessage
  | PeerLeftMessage
  | RelayErrorMessage
  | ({ type: string } & Record<string, unknown>)

export type RoomStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "error"

export type RoomMessage = { type: string; [key: string]: unknown }

export interface RoomSession {
  role: RoomRole
  opponent: PeerProfile | null
}

/** Minimal surface the socket needs; `readyState === 1` means open. */
export interface WebSocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: string, listener: (event: MessageDataEvent) => void): void
}

export interface MessageDataEvent {
  data?: unknown
}

export const SOCKET_OPEN = 1

/** Voluntary departure: the relay maps exactly this pair to `closed`. */
const CLOSE_CODE_LEAVE = 1000
const CLOSE_REASON_LEAVE = "client closing"
/**
 * G F395: internal recycle. 4000 is the private-use range and the relay's
 * existing ternary already maps anything but (1000, "client closing") to
 * the transient `disconnect` — no relay change required.
 */
const CLOSE_CODE_RECYCLE = 4000
const CLOSE_REASON_RECYCLE = "reconnecting"

export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000
const DEFAULT_TOKEN_PREFIX = "fuurma:room-token:"
const DEFAULT_SLOT_TOKEN_PREFIX = "fuurma:room-slot-token:"

export interface ReconnectPolicy {
  /** Attempts after the initial connect. Default 6. */
  maxAttempts?: number
  /** First delay. Default 800 ms. */
  baseMs?: number
  /** Delay cap. Default 8000 ms. */
  maxMs?: number
}

export interface RoomSocketOptions {
  wsUrl: string
  game: string
  guestId: string
  displayName: string
  role?: RoomRole
  /** Per-player join capability issued by matchmaking; echoed in `hello`. */
  slotToken?: string
  autoReconnect?: boolean
  reconnect?: ReconnectPolicy
  /** Bound on socket-open + `welcome` before the attempt is abandoned. */
  handshakeTimeoutMs?: number
  /** Storage prefix for reconnectToken; per-game so persisted tokens survive. */
  tokenPrefix?: string
  /** Storage prefix for slotToken; per-game so persisted tokens survive. */
  slotTokenPrefix?: string
  socket?: (url: string) => WebSocketLike
  storage?: StorageLike | null
}

function defaultSocket(url: string): WebSocketLike {
  const g = globalThis as unknown as { WebSocket?: new (url: string) => WebSocketLike }
  if (!g.WebSocket) throw new Error("RoomSocket: no WebSocket available (inject `socket`)")
  return new g.WebSocket(url)
}

/** localStorage key for a room credential, or null when the URL has no room id. */
function roomIdFromUrl(wsUrl: string): string | null {
  const match = /\/room\/([A-Za-z0-9_-]{4,64})/.exec(wsUrl)
  return match ? match[1] : null
}

function loadToken(storage: StorageLike | null, key: string | null): string | null {
  if (!key) return null
  try {
    return storage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function saveToken(storage: StorageLike | null, key: string | null, token: string): void {
  if (!key) return
  try {
    storage?.setItem(key, token)
  } catch {
    // Private mode etc: memory retention still covers in-session reconnects.
  }
}

function dropToken(storage: StorageLike | null, key: string | null): void {
  if (!key) return
  try {
    storage?.removeItem(key)
  } catch {
    // Already gone or denied — either way there is nothing to reclaim.
  }
}

export class RoomSocket {
  private readonly opts: {
    wsUrl: string
    game: string
    guestId: string
    displayName: string
    role: RoomRole | null
    autoReconnect: boolean
    maxAttempts: number
    baseMs: number
    maxMs: number
    handshakeTimeoutMs: number
    tokenPrefix: string
    slotTokenPrefix: string
    createSocket: (url: string) => WebSocketLike
  }
  private readonly storage: StorageLike | null

  private ws: WebSocketLike | null = null
  private status: RoomStatus = "idle"
  private role: RoomRole | null = null
  private opponent: PeerProfile | null = null
  private closedByUser = false
  private hadSession = false
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null
  private handshakeSocket: WebSocketLike | null = null
  private attemptSeq = 0
  private activeAttempt: number | null = null
  private welcomeResolvers: Array<(value: RoomSession) => void> = []
  private welcomeRejecters: Array<(reason: Error) => void> = []
  private pendingConnect: Promise<RoomSession> | null = null
  private preWelcomeError: FuurmaError | null = null
  private reconnectToken: string | null = null
  private slotToken: string | null = null

  private messageHandler: ((msg: RoomEnvelope) => void) | null = null
  private statusHandler: ((status: RoomStatus, detail?: string) => void) | null = null

  constructor(opts: RoomSocketOptions) {
    this.opts = {
      wsUrl: opts.wsUrl,
      game: opts.game,
      guestId: opts.guestId,
      displayName: opts.displayName,
      role: opts.role ?? null,
      autoReconnect: opts.autoReconnect ?? true,
      maxAttempts: opts.reconnect?.maxAttempts ?? 6,
      baseMs: opts.reconnect?.baseMs ?? 800,
      maxMs: opts.reconnect?.maxMs ?? 8000,
      handshakeTimeoutMs: opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      tokenPrefix: opts.tokenPrefix ?? DEFAULT_TOKEN_PREFIX,
      slotTokenPrefix: opts.slotTokenPrefix ?? DEFAULT_SLOT_TOKEN_PREFIX,
      createSocket: opts.socket ?? defaultSocket,
    }
    const storage =
      opts.storage === undefined
        ? ((globalThis as unknown as { localStorage?: StorageLike }).localStorage ?? null)
        : opts.storage
    this.storage = storage
    // Retained credentials from a previous session in this room (MM-01):
    // a refresh reclaims the same slot within the server grace window.
    this.reconnectToken = loadToken(this.storage, this.tokenKey())
    if (opts.slotToken) saveToken(this.storage, this.slotTokenKey(), opts.slotToken)
    this.slotToken = opts.slotToken ?? loadToken(this.storage, this.slotTokenKey())
  }

  /** Update the capability echoed on subsequent hello frames; persists it. */
  setSlotToken(token: string | null): void {
    this.slotToken = token
    if (token) saveToken(this.storage, this.slotTokenKey(), token)
  }

  setMessageHandler(handler: (msg: RoomEnvelope) => void): void {
    this.messageHandler = handler
  }

  setStatusHandler(handler: (status: RoomStatus, detail?: string) => void): void {
    this.statusHandler = handler
  }

  getStatus(): RoomStatus {
    return this.status
  }

  getRole(): RoomRole | null {
    return this.role
  }

  isConnected(): boolean {
    return this.status === "connected" && this.ws?.readyState === SOCKET_OPEN
  }

  async connect(): Promise<RoomSession> {
    this.closedByUser = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.status === "connected" && this.role) {
      return { role: this.role, opponent: this.opponent }
    }
    return this.kickConnect()
  }

  /**
   * F37: every path that wants a socket attempt funnels through
   * pendingConnect — connect(), reconnectNow(), and the scheduled retry.
   */
  private kickConnect(): Promise<RoomSession> {
    if (!this.pendingConnect) {
      this.pendingConnect = this.openSocket().finally(() => {
        this.pendingConnect = null
      })
    }
    return this.pendingConnect
  }

  /** Frames go verbatim: no `protocol` envelope (never read; T 3.1). */
  send(message: RoomMessage): boolean {
    if (!this.ws || this.ws.readyState !== SOCKET_OPEN) return false
    try {
      this.ws.send(JSON.stringify(message))
      return true
    } catch {
      return false
    }
  }

  /** Voluntary departure: the peer reads `closed`, credentials are forgotten. */
  close(): void {
    this.teardown(CLOSE_CODE_LEAVE, CLOSE_REASON_LEAVE, "You left", true)
  }

  /**
   * Recycle this socket because it is about to be reopened, NOT because
   * the player left (G F395). Identical local teardown under the transient
   * signature, so the peer waits instead of recording a win — but the
   * credentials are kept for the next hello.
   */
  closeForReconnect(): void {
    this.teardown(CLOSE_CODE_RECYCLE, CLOSE_REASON_RECYCLE, "Reconnecting", false)
  }

  private teardown(code: number, reason: string, statusDetail: string, forgetCreds: boolean): void {
    this.closedByUser = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
    }
    this.handshakeSocket = null
    this.activeAttempt = null
    if (forgetCreds) this.forgetCurrentRoom()
    if (this.ws) {
      try {
        this.ws.close(code, reason)
      } catch {
        /* ignore */
      }
      this.ws = null
    }
    this.setStatus("disconnected", statusDetail)
    for (const reject of this.welcomeRejecters) {
      reject(new Error("closed"))
    }
    this.welcomeRejecters = []
    this.welcomeResolvers = []
  }

  /** Drop both credentials for `roomId` (report 3.7: discard when over). */
  forget(roomId: string): void {
    dropToken(this.storage, this.opts.tokenPrefix + roomId)
    dropToken(this.storage, this.opts.slotTokenPrefix + roomId)
  }

  private tokenKey(): string | null {
    const roomId = roomIdFromUrl(this.opts.wsUrl)
    return roomId ? this.opts.tokenPrefix + roomId : null
  }

  private slotTokenKey(): string | null {
    const roomId = roomIdFromUrl(this.opts.wsUrl)
    return roomId ? this.opts.slotTokenPrefix + roomId : null
  }

  private forgetCurrentRoom(): void {
    const roomId = roomIdFromUrl(this.opts.wsUrl)
    if (roomId) this.forget(roomId)
  }

  /** Skip the backoff timer and attempt an immediate reconnect; re-arms the budget. */
  reconnectNow(): void {
    if (this.closedByUser || !this.opts.autoReconnect) return
    if (this.ws?.readyState === SOCKET_OPEN) return
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.reconnectAttempt = 0
    this.setStatus("reconnecting", "Reconnecting now…")
    this.kickConnect().catch(() => {
      if (this.opts.autoReconnect) this.scheduleReconnect()
    })
  }

  private openSocket(): Promise<RoomSession> {
    return new Promise<RoomSession>((resolve, reject) => {
      this.setStatus(this.status === "reconnecting" ? "reconnecting" : "connecting")
      this.preWelcomeError = null
      const sep = this.opts.wsUrl.includes("?") ? "&" : "?"
      const url = `${this.opts.wsUrl}${sep}game=${encodeURIComponent(this.opts.game)}`
      let ws: WebSocketLike
      try {
        ws = this.opts.createSocket(url)
      } catch (err) {
        reject(err instanceof Error ? err : new Error("websocket construction failed"))
        if (this.opts.autoReconnect && this.hadSession) this.scheduleReconnect()
        return
      }
      this.ws = ws

      let settled = false
      let welcomed = false

      const attempt = ++this.attemptSeq
      const isCurrent = (): boolean => this.activeAttempt === attempt
      const supersede = (): void => {
        if (this.activeAttempt === attempt) this.activeAttempt = null
        if (this.handshakeSocket === ws) this.handshakeSocket = null
      }
      this.activeAttempt = attempt
      this.handshakeSocket = ws

      const settleWelcome = (session: RoomSession | null, error: Error | null): void => {
        const resolvers = this.welcomeResolvers
        const rejecters = this.welcomeRejecters
        this.welcomeResolvers = []
        this.welcomeRejecters = []
        if (session) {
          for (const r of resolvers) r(session)
        }
        if (error) {
          for (const r of rejecters) r(error)
        }
      }

      const retireHandshakeTimer = (): void => {
        if (this.handshakeTimer) {
          clearTimeout(this.handshakeTimer)
          this.handshakeTimer = null
        }
        if (this.handshakeSocket === ws) this.handshakeSocket = null
      }

      // F460/G F892: a socket that never opens, or opens and never receives
      // `welcome`, must still settle — otherwise `connect()` pends forever.
      this.handshakeTimer = setTimeout(() => {
        if (this.handshakeTimer) this.handshakeTimer = null
        if (!isCurrent() || settled) return
        settled = true
        supersede()
        if (this.ws === ws) this.ws = null
        settleWelcome(
          null,
          new FuurmaError(
            "handshake-timeout",
            `socket handshake timed out after ${this.opts.handshakeTimeoutMs}ms`,
            { terminal: !this.hadSession },
          ),
        )
        try {
          ws.close(CLOSE_CODE_RECYCLE, "handshake timeout")
        } catch {
          /* ignore */
        }
        // F151 preserved: only an ESTABLISHED session retries.
        if (this.opts.autoReconnect && this.hadSession) this.scheduleReconnect()
        else this.setStatus("disconnected", "Connection timed out")
      }, this.opts.handshakeTimeoutMs)

      ws.addEventListener("open", () => {
        // F460: a superseded socket must not send `hello` on the live socket.
        if (!isCurrent()) {
          try {
            ws.close(1000, "superseded")
          } catch {
            /* ignore */
          }
          return
        }
        const sent = this.sendHello(ws)
        if (!sent) {
          settled = true
          retireHandshakeTimer()
          supersede()
          if (this.ws === ws) this.ws = null
          settleWelcome(null, new Error("hello send failed"))
          ws.close()
          // F746: the attempt is superseded, so the `close` handler's F151
          // retry never runs for it — arm the retry here instead.
          if (this.opts.autoReconnect && this.hadSession) this.scheduleReconnect()
          else this.setStatus("disconnected", "Could not send hello")
        }
      })

      ws.addEventListener("message", (event: MessageDataEvent) => {
        if (typeof event?.data !== "string") return
        const parsed = parseEnvelope(event.data)
        if (!parsed) return
        // F253: the relay rejects joins with {type:"error",...} then closes.
        // Capture the reason so the close settles with it, not the generic
        // "socket closed before welcome".
        if (parsed.type === "error" && this.welcomeResolvers.length > 0) {
          const refusal = parsed as RelayErrorMessage
          if (typeof refusal.message === "string") {
            this.preWelcomeError = new FuurmaError(
              mapRoomRefusal(refusal.message, refusal.code),
              refusal.message,
              { terminal: true },
            )
          }
        }
        if (parsed.type === "welcome") {
          // F460: a `welcome` past the deadline must be ignored.
          if (!isCurrent() || settled) return
          // Validated BEFORE the handshake settles (F748): a frame that is
          // not a seat must not mark the session as welcomed.
          const welcome = parseWelcome(parsed as unknown as Record<string, unknown>)
          if (!welcome) {
            this.preWelcomeError = new FuurmaError("protocol", "malformed welcome frame", {
              terminal: true,
            })
            ws.close()
            return
          }
          settled = true
          welcomed = true
          retireHandshakeTimer()
          this.role = welcome.role
          this.opponent = welcome.opponent
          if (typeof welcome.reconnectToken === "string" && welcome.reconnectToken) {
            this.reconnectToken = welcome.reconnectToken
            saveToken(this.storage, this.tokenKey(), welcome.reconnectToken)
          }
          this.hadSession = true
          this.preWelcomeError = null
          this.reconnectAttempt = 0
          this.setStatus("connected")
          const session: RoomSession = { role: welcome.role, opponent: welcome.opponent }
          if (this.welcomeResolvers.length > 0) {
            for (const r of this.welcomeResolvers) r(session)
            this.welcomeResolvers = []
            this.welcomeRejecters = []
            this.messageHandler?.(parsed)
          } else {
            this.messageHandler?.(parsed)
          }
          return
        }
        // Terminal room-over reasons own their credentials (report 3.7).
        if (parsed.type === "peer-left") {
          const reason = (parsed as PeerLeftMessage).reason
          if (reason === "closed" || reason === "expired") this.forgetCurrentRoom()
        }
        this.messageHandler?.(parsed)
      })

      ws.addEventListener("close", () => {
        if (this.ws === ws) this.ws = null
        if (this.closedByUser) {
          this.setStatus("disconnected")
          return
        }
        // F460: a superseded attempt's `close` must not touch the live one.
        if (!isCurrent()) return
        // A `close` after a successful `welcome` is an ESTABLISHED-session
        // drop (F151 owns it); any other settled attempt is a duplicate.
        if (settled && !welcomed) return
        settled = true
        retireHandshakeTimer()
        supersede()
        if (!welcomed) {
          settleWelcome(null, this.preWelcomeError ?? new Error("socket closed before welcome"))
        } else {
          this.preWelcomeError = null
        }
        // F151: only an ESTABLISHED session retries; a failed initial
        // connect stays a terminal error.
        if (this.opts.autoReconnect && this.hadSession) this.scheduleReconnect()
        else this.setStatus("disconnected")
      })

      ws.addEventListener("error", () => {
        if (!isCurrent() || (settled && !welcomed)) return
        settled = true
        retireHandshakeTimer()
        // Do NOT supersede: the spec-mandated `close` that follows owns
        // terminal state, and it returns early for a non-current attempt.
        if (!welcomed) {
          settleWelcome(null, this.preWelcomeError ?? new Error("socket error"))
        }
        // close event will follow; reconnect happens there
      })

      this.welcomeResolvers.push(resolve)
      this.welcomeRejecters.push(reject)
    })
  }

  private sendHello(ws: WebSocketLike): boolean {
    if (ws.readyState !== SOCKET_OPEN) return false
    try {
      const hello: Record<string, unknown> = {
        type: "hello",
        guestId: this.opts.guestId,
        displayName: this.opts.displayName,
      }
      const role = this.role ?? this.opts.role
      if (role) hello.role = role
      if (this.reconnectToken) hello.reconnectToken = this.reconnectToken
      if (this.slotToken) hello.slotToken = this.slotToken
      ws.send(JSON.stringify(hello))
      return true
    } catch {
      return false
    }
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || !this.opts.autoReconnect) return
    // Never auto-reconnect before a session was established (F151).
    if (this.role === null) return
    if (this.reconnectTimer) return
    if (this.reconnectAttempt >= this.opts.maxAttempts) {
      this.setStatus("disconnected", "Reconnect gave up; retry when ready")
      return
    }
    const base = Math.min(
      this.opts.maxMs,
      this.opts.baseMs * 2 ** Math.min(this.reconnectAttempt, 8),
    )
    // ±25% jitter against thundering herds on DO restarts (T P14).
    const jitter = base * (0.75 + Math.random() * 0.5)
    const delay = Math.round(jitter)
    this.reconnectAttempt += 1
    this.setStatus("reconnecting", `Reconnecting in ${Math.round(delay / 100) / 10}s`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.kickConnect().catch(() => {
        // ignored: reconnect lifecycle handles errors via close + retry
      })
    }, delay)
  }

  private setStatus(status: RoomStatus, detail?: string): void {
    this.status = status
    this.statusHandler?.(status, detail)
  }
}

/**
 * The welcome envelope, validated field by field (T F748).
 * `parseEnvelope` only proves object-with-string-type; the seat itself is
 * checked here because the renderer reads the opponent's shape.
 */
function parseWelcome(frame: Record<string, unknown>): WelcomeMessage | null {
  const role = frame.role
  if (role !== "host" && role !== "guest") return null

  const rawOpponent = frame.opponent
  let opponent: PeerProfile | null = null
  if (rawOpponent !== null && rawOpponent !== undefined) {
    if (typeof rawOpponent !== "object") return null
    const candidate = rawOpponent as Record<string, unknown>
    if (typeof candidate.guestId !== "string") return null
    if (typeof candidate.displayName !== "string") return null
    opponent = { guestId: candidate.guestId, displayName: candidate.displayName }
  }

  const reconnectToken = frame.reconnectToken
  if (reconnectToken !== undefined && typeof reconnectToken !== "string") return null

  return {
    type: "welcome",
    role,
    opponent,
    ...(typeof reconnectToken === "string" ? { reconnectToken } : {}),
  }
}

function parseEnvelope(raw: string): RoomEnvelope | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const obj = parsed as Record<string, unknown>
  if (typeof obj.type !== "string") return null
  return obj as unknown as RoomEnvelope
}
