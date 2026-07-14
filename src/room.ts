import { DurableObject } from "cloudflare:workers"

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
 * notifies the remaining peer via `peer-left`.
 *
 * Spec: ../../newProjectsPlanner/migrations/2026-07-games-do-websocket-migration.md
 */

const RECONNECT_GRACE_MS = 30_000
const MAX_SLOTS = 2

/**
 * Message types owned by the room server. These are never relayed
 * peer-to-peer — a malicious client could otherwise spoof `peer-left`
 * or `welcome` to trick the other peer into a wrong state.
 */
const RESERVED_TYPES = new Set(["hello", "ping", "welcome", "peer-joined", "peer-left", "error"])

interface Slot {
  guestId: string
  displayName: string
  role: "host" | "guest"
  disconnectedAt: number | null
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

const ROOM_STATE_KEY = "room-state"

export class GameRoomDO extends DurableObject {
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", {
        status: 426,
        headers: { "Access-Control-Allow-Origin": "*" },
      })
    }

    const url = new URL(request.url)
    const game = url.searchParams.get("game") ?? "tictactoe"

    const state = await this.loadState()
    // Pin the game tag on the first connection only. Overwriting it on
    // later connections would let a different game silently hijack a
    // room if two games ever generated the same roomId.
    if (state.slots.length === 0 && state.game !== game) {
      state.game = game
      await this.saveState(state)
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    this.ctx.acceptWebSocket(server)
    return new Response(null, { status: 101, webSocket: client })
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
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
      default:
        // Reject reserved server message types from clients to prevent
        // spoofing (e.g. a peer sending a fake `peer-left`).
        if (RESERVED_TYPES.has(type)) {
          this.sendError(ws, "invalid", `reserved type: ${type}`)
          return
        }
        // Relay any other well-formed message verbatim to the other peer.
        // Each game owns its own protocol on top of the room envelope.
        this.fanOut(ws, parsed)
    }
  }

  override async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    wasClean: boolean,
  ): Promise<void> {
    const att = ws.deserializeAttachment() as ConnectionAttachment | null
    if (!att) return

    const state = await this.loadState()
    const slot = state.slots.find((s) => s.guestId === att.guestId)
    if (!slot || slot.disconnectedAt !== null) return

    slot.disconnectedAt = Date.now()
    await this.saveState(state)
    await this.ctx.storage.setAlarm(Date.now() + RECONNECT_GRACE_MS)

    this.broadcastExcept(ws, {
      type: "peer-left",
      reason: wasClean ? "closed" : "disconnect",
    })
  }

  override async alarm(): Promise<void> {
    const state = await this.loadState()
    const sockets = this.ctx.getWebSockets()
    const connectedGuestIds = new Set<string>()
    for (const ws of sockets) {
      const att = ws.deserializeAttachment() as ConnectionAttachment | null
      if (att) connectedGuestIds.add(att.guestId)
    }

    let changed = false
    state.slots = state.slots.filter((slot) => {
      if (slot.disconnectedAt === null) return true
      if (connectedGuestIds.has(slot.guestId)) {
        slot.disconnectedAt = null
        changed = true
        return true
      }
      changed = true
      return false
    })

    if (!changed) return

    await this.saveState(state)

    const stillDisconnected = state.slots.some((s) => s.disconnectedAt !== null)
    if (stillDisconnected) {
      await this.ctx.storage.setAlarm(Date.now() + RECONNECT_GRACE_MS)
    } else {
      await this.ctx.storage.deleteAlarm()
    }

    for (const ws of sockets) {
      this.safeSend(ws, JSON.stringify({ type: "peer-left", reason: "disconnect" }))
    }
  }

  private async handleHello(
    ws: WebSocket,
    msg: { guestId: string; displayName?: string; role?: unknown },
  ): Promise<void> {
    if (typeof msg.guestId !== "string" || msg.guestId.length < 1 || msg.guestId.length > 64) {
      this.sendError(ws, "invalid", "guestId required (1-64 chars)")
      ws.close(1008, "invalid hello")
      return
    }

    const rawName = typeof msg.displayName === "string" ? msg.displayName : ""
    const displayName = rawName.replace(/[<>]/g, "").trim().slice(0, 20) || "Guest"
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

      slot = { guestId: msg.guestId, displayName, role, disconnectedAt: null }
      state.slots.push(slot)
    }

    await this.saveState(state)

    ws.serializeAttachment({
      guestId: slot.guestId,
      displayName: slot.displayName,
      role: slot.role,
    })

    const opponent = state.slots.find((s) => s.guestId !== msg.guestId) ?? null
    this.safeSend(
      ws,
      JSON.stringify({
        type: "welcome",
        role: slot.role,
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
}
