import { DurableObject } from "cloudflare:workers"
import {
  ALLOWED_GAMES,
  jsonResponse,
  logEvent,
  MAX_GUEST_ID_LENGTH,
  MAX_MESSAGE_BYTES,
  sanitizeDisplayName,
  utf8ByteLength,
} from "./utils"

/**
 * Per-room WebSocket relay for two-player turn-based games.
 *
 * Replaces PeerJS P2P. Each room is one Durable Object instance keyed by
 * `roomId`. The DO accepts up to two WebSocket connections, relays messages
 * between them, and survives hibernation (and disconnects) by persisting
 * per-connection attachment + slot state via `serializeAttachment` and
 * `ctx.storage`.
 *
 * Reconnect grace: when a socket disconnects, the slot is kept for 30s.
 * A new socket presenting the same `guestId` reattaches and gets the same
 * role. After the grace expires, an `alarm` cleans up the orphan slot and
 * notifies the remaining peer via `peer-left` with reason `expired`.
 *
 * Spec: ../../hub/migrations/2026-07-games-do-websocket-migration.md
 */

const RECONNECT_GRACE_MS = 30_000
const HELLO_TIMEOUT_MS = 10_000
const MAX_SLOTS = 2

/**
 * Message types owned by the room server. These are never relayed
 * peer-to-peer — a malicious client could otherwise spoof `peer-left`
 * or `welcome` to trick the other peer into a wrong state.
 */
const RESERVED_TYPES = new Set([
  "hello",
  "ping",
  "welcome",
  "peer-joined",
  "peer-reconnected",
  "peer-left",
  "error",
])

interface Slot {
  guestId: string
  displayName: string
  role: "host" | "guest"
  disconnectedAt: number | null
  /**
   * Private per-player reconnect credential (MM-01). Minted when the slot is
   * created, returned only in that socket's `welcome`, and required to
   * reclaim the slot after a disconnect. Never sent to the opponent.
   * Slots persisted before MM-01 lack this field and get one backfilled on
   * their next uncontested hello (see handleHello).
   */
  reconnectToken: string
}

/** 128 bits of randomness, hex-encoded — the per-slot reconnect credential. */
function generateReconnectToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")
}

interface RoomState {
  game: string
  slots: Slot[]
}

interface ConnectionAttachment {
  guestId: string
  displayName: string
  role: "host" | "guest"
}

interface PendingConnectionAttachment {
  pending: true
  connectedAt: number
}

type RoomAttachment = ConnectionAttachment | PendingConnectionAttachment

const isPendingConnection = (
  attachment: RoomAttachment,
): attachment is PendingConnectionAttachment => "pending" in attachment

const ROOM_STATE_KEY = "room-state"

export class GameRoomDO extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", JSON.stringify({ type: "pong" })),
    )
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", {
        status: 426,
        headers: { "Access-Control-Allow-Origin": "*" },
      })
    }

    const url = new URL(request.url)
    const rawGame = url.searchParams.get("game")
    const game = rawGame ?? "tictactoe"
    if (!ALLOWED_GAMES.has(game)) {
      return jsonResponse({ error: "unknown game" }, 400)
    }

    const state = await this.loadState()
    // Pin the game tag on the first connection only. Overwriting it on
    // later connections would let a different game silently hijack a
    // room if two games ever generated the same roomId.
    if (state.slots.length === 0 && state.game !== game) {
      state.game = game
      await this.saveState(state)
    } else if (state.slots.length > 0 && state.game !== game) {
      return jsonResponse({ error: "room belongs to another game" }, 409)
    }

    // Bound unauthenticated sockets before accepting the upgrade. Without
    // this guard an attacker can fill a room with connections that never
    // send hello, consuming the two useful room slots indefinitely.
    if (this.ctx.getWebSockets().length >= MAX_SLOTS) {
      return jsonResponse({ error: "room connection limit reached" }, 429, {
        "Retry-After": String(Math.ceil(HELLO_TIMEOUT_MS / 1000)),
      })
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ pending: true, connectedAt: Date.now() })
    await this.schedulePendingHandshakeAlarm()
    return new Response(null, { status: 101, webSocket: client })
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Reject oversized frames early to prevent memory abuse. String frames
    // are measured in UTF-8 bytes (MM-04): .length counts UTF-16 code units,
    // letting multibyte text exceed the documented wire-byte cap ~4x.
    const byteLength = typeof message === "string" ? utf8ByteLength(message) : message.byteLength
    if (byteLength > MAX_MESSAGE_BYTES) {
      this.sendError(ws, "invalid", `message too large (max ${MAX_MESSAGE_BYTES} bytes)`)
      return
    }

    if (typeof message !== "string") {
      this.sendError(ws, "invalid", "expected string frame")
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(message)
    } catch {
      this.sendError(ws, "invalid", "not json")
      return
    }

    if (!parsed || typeof parsed !== "object") {
      this.sendError(ws, "invalid", "expected object")
      return
    }

    const type = (parsed as { type?: unknown }).type
    if (typeof type !== "string") {
      this.sendError(ws, "invalid", "missing type")
      return
    }

    switch (type) {
      case "hello":
        await this.handleHello(ws, parsed as { guestId: string; displayName?: string })
        return
      case "ping":
        this.safeSend(ws, JSON.stringify({ type: "pong" }))
        return
      default: {
        // Reject reserved server message types from clients to prevent
        // spoofing (e.g. a peer sending a fake `peer-left`).
        if (RESERVED_TYPES.has(type)) {
          this.sendError(ws, "invalid", `reserved type: ${type}`)
          return
        }
        // Relay only from sockets that have completed hello; ignore frames
        // from any other unauthenticated socket.
        const attachment = ws.deserializeAttachment() as RoomAttachment | null
        if (!attachment || isPendingConnection(attachment)) {
          this.sendError(ws, "invalid", "send hello first")
          return
        }
        // Relay any other well-formed message verbatim to the other peer.
        // Each game owns its own protocol on top of the room envelope.
        this.fanOut(ws, parsed)
      }
    }
  }

  override async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    // Auto-reply to the close frame (safe even with auto-reply enabled).
    try {
      ws.close(code, reason)
    } catch {
      // already closed
    }

    const att = ws.deserializeAttachment() as RoomAttachment | null
    if (!att || isPendingConnection(att)) {
      await this.scheduleRoomAlarm(await this.loadState())
      return
    }

    const state = await this.loadState()
    const slot = state.slots.find((s) => s.guestId === att.guestId)
    if (!slot || slot.disconnectedAt !== null) return

    slot.disconnectedAt = Date.now()
    await this.saveState(state)
    await this.ctx.storage.setAlarm(Date.now() + RECONNECT_GRACE_MS)

    this.broadcastExcept(ws, {
      type: "peer-left",
      reason: code === 1000 && reason === "client closing" ? "closed" : "disconnect",
    })
  }

  override async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error)
    logEvent("error", "websocket_error", { message })
    // The close event will follow and handle slot cleanup + reconnect grace.
    ws.close(1011, "websocket error")
  }

  override async alarm(): Promise<void> {
    const state = await this.loadState()
    const sockets = this.ctx.getWebSockets()
    const connectedGuestIds = new Set<string>()
    const now = Date.now()
    let nextPendingDeadline: number | null = null
    for (const ws of sockets) {
      const att = ws.deserializeAttachment() as RoomAttachment | null
      if (!att) continue
      if (isPendingConnection(att)) {
        const deadline = att.connectedAt + HELLO_TIMEOUT_MS
        if (deadline <= now) {
          try {
            ws.close(1008, "hello timeout")
          } catch {
            // already closed
          }
        } else {
          nextPendingDeadline =
            nextPendingDeadline === null ? deadline : Math.min(nextPendingDeadline, deadline)
        }
        continue
      }
      connectedGuestIds.add(att.guestId)
    }

    let changed = false
    const removedGuestIds: string[] = []
    state.slots = state.slots.filter((slot) => {
      if (slot.disconnectedAt === null) return true
      if (connectedGuestIds.has(slot.guestId)) {
        // Peer reconnected within the grace period — clear the disconnect
        // marker but don't broadcast peer-left.
        slot.disconnectedAt = null
        changed = true
        return true
      }
      // Grace expired and peer didn't reconnect — remove the slot.
      removedGuestIds.push(slot.guestId)
      changed = true
      return false
    })

    if (changed) await this.saveState(state)

    const nextSlotDeadline = state.slots.some((s) => s.disconnectedAt !== null)
      ? now + RECONNECT_GRACE_MS
      : null
    const nextAlarm =
      nextPendingDeadline === null
        ? nextSlotDeadline
        : nextSlotDeadline === null
          ? nextPendingDeadline
          : Math.min(nextPendingDeadline, nextSlotDeadline)
    if (nextAlarm === null) {
      await this.ctx.storage.deleteAlarm()
    } else {
      await this.ctx.storage.setAlarm(nextAlarm)
    }

    if (!changed) return

    // Only broadcast peer-left if a slot was actually removed (not
    // when a peer reconnected within the grace period).
    if (removedGuestIds.length > 0) {
      for (const ws of sockets) {
        this.safeSend(ws, JSON.stringify({ type: "peer-left", reason: "expired" }))
      }
    }
  }

  private async handleHello(
    ws: WebSocket,
    msg: { guestId: string; displayName?: string; role?: unknown; reconnectToken?: unknown },
  ): Promise<void> {
    const pending = ws.deserializeAttachment() as PendingConnectionAttachment | null
    if (pending?.pending !== true || Date.now() - pending.connectedAt > HELLO_TIMEOUT_MS) {
      this.sendError(ws, "invalid", "hello handshake expired")
      ws.close(1008, "hello timeout")
      return
    }

    if (
      typeof msg.guestId !== "string" ||
      msg.guestId.length < 1 ||
      msg.guestId.length > MAX_GUEST_ID_LENGTH
    ) {
      this.sendError(ws, "invalid", `guestId required (1-${MAX_GUEST_ID_LENGTH} chars)`)
      ws.close(1008, "invalid hello")
      return
    }

    const displayName = sanitizeDisplayName(msg.displayName)
    const requestedRole =
      msg.role === "host" || msg.role === "guest" ? (msg.role as "host" | "guest") : null

    const state = await this.loadState()
    const existing = state.slots.find((s) => s.guestId === msg.guestId)
    const sockets = this.ctx.getWebSockets()
    const hasActiveSocket = sockets.some((s) => {
      const a = s.deserializeAttachment() as ConnectionAttachment | null
      return a?.guestId === msg.guestId
    })

    let slot: Slot
    let isReconnect = false

    if (existing) {
      if (hasActiveSocket) {
        this.sendError(ws, "unknown", "already connected from another tab")
        ws.close(1013, "duplicate connection")
        return
      }
      // Reclaim requires the private credential minted at slot creation
      // (MM-01): the public guestId alone must not reattach a disconnected
      // slot, because the opponent learns it from welcome/peer-joined.
      const presented = typeof msg.reconnectToken === "string" ? msg.reconnectToken : null
      if (typeof msg.reconnectToken !== "undefined" && presented === null) {
        this.sendError(ws, "invalid", "reconnectToken must be a string")
        ws.close(1008, "invalid hello")
        return
      }
      if (!existing.reconnectToken) {
        // Legacy slot persisted before MM-01: backfill on this uncontested
        // hello (no active socket holds the identity) and require the
        // credential from now on.
        existing.reconnectToken = generateReconnectToken()
      } else if (presented !== existing.reconnectToken) {
        this.sendError(ws, "invalid", "reconnect credential required")
        ws.close(1008, "reconnect rejected")
        return
      }
      existing.disconnectedAt = null
      existing.displayName = displayName
      slot = existing
      isReconnect = true
    } else {
      if (state.slots.length >= MAX_SLOTS) {
        this.sendError(ws, "unknown", "room full")
        ws.close(1013, "room full")
        return
      }

      let role: "host" | "guest" = requestedRole ?? (state.slots.length === 0 ? "host" : "guest")
      // If the requested role is already taken, fall back to the other one.
      const takenRoles = new Set(state.slots.map((s) => s.role))
      if (takenRoles.has(role)) {
        role = role === "host" ? "guest" : "host"
      }
      // Final sanity check: if the fallback is also taken, the room is full
      // (should not happen because MAX_SLOTS === 2 and roles are unique).
      if (takenRoles.has(role)) {
        this.sendError(ws, "unknown", "room full")
        ws.close(1013, "room full")
        return
      }

      slot = {
        guestId: msg.guestId,
        displayName,
        role,
        disconnectedAt: null,
        reconnectToken: generateReconnectToken(),
      }
      state.slots.push(slot)
    }

    await this.saveState(state)

    ws.serializeAttachment({
      guestId: slot.guestId,
      displayName: slot.displayName,
      role: slot.role,
    })
    await this.scheduleRoomAlarm(state)

    const opponent = state.slots.find((s) => s.guestId !== msg.guestId) ?? null
    this.safeSend(
      ws,
      JSON.stringify({
        type: "welcome",
        role: slot.role,
        // Self-only: the private reclaim credential. Peer-joined /
        // peer-reconnected broadcasts deliberately omit it (MM-01).
        reconnectToken: slot.reconnectToken,
        opponent: opponent
          ? { guestId: opponent.guestId, displayName: opponent.displayName }
          : null,
      }),
    )

    if (!isReconnect && opponent) {
      this.broadcastExcept(ws, {
        type: "peer-joined",
        opponent: { guestId: slot.guestId, displayName: slot.displayName },
      })
    } else if (isReconnect && opponent) {
      this.broadcastExcept(ws, {
        type: "peer-reconnected",
        opponent: { guestId: slot.guestId, displayName: slot.displayName },
      })
    }
  }

  private fanOut(from: WebSocket, msg: unknown): void {
    const str = JSON.stringify(msg)
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === from) continue
      this.safeSend(ws, str)
    }
  }

  private broadcastExcept(except: WebSocket, msg: unknown): void {
    const str = JSON.stringify(msg)
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue
      this.safeSend(ws, str)
    }
  }

  private sendError(ws: WebSocket, code: string, message: string): void {
    this.safeSend(ws, JSON.stringify({ type: "error", code, message }))
  }

  private safeSend(ws: WebSocket, data: string): void {
    try {
      ws.send(data)
    } catch {
      // socket may be closed; ignore
    }
  }

  private async loadState(): Promise<RoomState> {
    const stored = await this.ctx.storage.get<RoomState>(ROOM_STATE_KEY)
    return stored ?? { game: "tictactoe", slots: [] }
  }

  private async saveState(state: RoomState): Promise<void> {
    await this.ctx.storage.put(ROOM_STATE_KEY, state)
  }

  private async schedulePendingHandshakeAlarm(): Promise<void> {
    const deadline = Date.now() + HELLO_TIMEOUT_MS
    const currentAlarm = await this.ctx.storage.getAlarm()
    if (currentAlarm === null || currentAlarm > deadline) {
      await this.ctx.storage.setAlarm(deadline)
    }
  }

  private async scheduleRoomAlarm(state: RoomState): Promise<void> {
    const now = Date.now()
    let nextAlarm: number | null = state.slots.some((slot) => slot.disconnectedAt !== null)
      ? now + RECONNECT_GRACE_MS
      : null

    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as RoomAttachment | null
      if (!attachment || !isPendingConnection(attachment)) continue
      const deadline = attachment.connectedAt + HELLO_TIMEOUT_MS
      if (deadline <= now) continue
      nextAlarm = nextAlarm === null ? deadline : Math.min(nextAlarm, deadline)
    }

    if (nextAlarm === null) {
      await this.ctx.storage.deleteAlarm()
    } else {
      await this.ctx.storage.setAlarm(nextAlarm)
    }
  }
}
