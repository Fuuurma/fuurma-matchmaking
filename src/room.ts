import { DurableObject } from "cloudflare:workers"
import {
  ALLOWED_GAMES,
  corsHeaders,
  jsonResponse,
  logEvent,
  MAX_GUEST_ID_LENGTH,
  MAX_MESSAGE_BYTES,
  sanitizeDisplayName,
  secretsMatch,
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
 * History: the original migration plan (SF `migrations/2026-07-games-do-websocket-migration.md`,
 * removed 2026-09-10) is superseded by this header — recover it from SF git history if needed.
 */

const RECONNECT_GRACE_MS = 30_000
const HELLO_TIMEOUT_MS = 10_000
/**
 * How long a matchmade allocation waits for its seat to be filled. The
 * client connects immediately after `matched` lands, so 60s already covers
 * slow networks and tab resume; beyond that the allocated player is never
 * coming and the seated peer must be released instead of waiting forever.
 */
const EXPECTED_SEAT_DEADLINE_MS = 60_000

/**
 * Earliest reconnect-grace deadline still outstanding across `slots`.
 *
 * Each slot's deadline is derived from its own `disconnectedAt`, never from
 * "now". Deriving it from `now` on every wake-up made the alarm re-arm itself
 * `grace` ms into the future each time it fired for an unrelated reason, so a
 * slot could be kept alive indefinitely and a shorter deadline elsewhere was
 * masked. Slots whose grace has already elapsed are ignored here: the alarm
 * handler is what removes them, and by then no such slot remains.
 */
function earliestSlotDeadline(slots: ReadonlyArray<Slot>, now: number): number | null {
  let earliest: number | null = null
  for (const slot of slots) {
    if (slot.disconnectedAt === null) continue
    const deadline = slot.disconnectedAt + RECONNECT_GRACE_MS
    if (deadline <= now) continue
    if (earliest === null || deadline < earliest) earliest = deadline
  }
  return earliest
}
const MAX_SLOTS = 2

/**
 * Earliest seat-fill deadline across expected entries nobody claimed. An
 * entry counts as claimed once a slot exists for its guestId minted through
 * the allocation (`viaExpect`): while that seat lives, the reconnect-grace
 * reap — not this deadline — owns the expiry. Entries without `armedAt`
 * (persisted before the deadline existed) get a full window from `now`, so
 * the first alarm after a deploy cannot kill a match in flight.
 */
function earliestExpectedDeadline(
  expected: RoomState["expected"],
  slots: ReadonlyArray<Slot>,
  now: number,
): number | null {
  if (!expected) return null
  const claimed = new Set(slots.filter((s) => s.viaExpect === true).map((s) => s.guestId))
  let earliest: number | null = null
  for (const [guestId, entry] of Object.entries(expected)) {
    if (claimed.has(guestId)) continue
    const deadline = (entry.armedAt ?? now) + EXPECTED_SEAT_DEADLINE_MS
    if (earliest === null || deadline < earliest) earliest = deadline
  }
  return earliest
}

/**
 * Message types owned by the room server. These are never relayed
 * peer-to-peer — a malicious client could otherwise spoof `peer-left`
 * or `welcome` to trick the other peer into a wrong state.
 *
 * `room_closed` and `host_migrated` belong here for the same reason, and were
 * missing until 10-04. Clients treat both as authoritative: `room_closed`
 * ends the recipient's game and records its own side as the result, and
 * `host_migrated` assigns the recipient the host role. Neither is emitted by
 * this Worker yet, so a peer could only ever produce one by sending it — the
 * `default:` relay branch below forwards anything not listed here verbatim.
 * The recipient's store even documents the wrong invariant, saying the "DO
 * tore the room down", which is precisely what a peer-supplied frame
 * impersonates.
 *
 * `player_left` joined 10-07 (F734): it is the DO's heartbeat/end variant of
 * `peer-left` and the client treats it as server-authoritative — a forged one
 * ended the host's match and committed a result. Both sides of the contract
 * were checked before reserving it: no server code emits it yet, and the
 * client library has no send path for it (its `player_left` handling is
 * inbound-only), so reserving cannot break a client-originated flow.
 *
 * `pong` remains unreserved on purpose: the platform answers pings via the
 * auto-response pair and a client-sent pong is inert, so relaying it is
 * harmless. Tracked rather than silently decided.
 */
const RESERVED_TYPES = new Set([
  "hello",
  "ping",
  "welcome",
  "peer-joined",
  "peer-reconnected",
  "peer-left",
  "player_left",
  "error",
  "room_closed",
  "host_migrated",
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
   * Slots persisted before MM-01 lack this field and are NOT backfilled:
   * there is no way to tell the owner from the opponent, so the first
   * claimant retires the identity instead (see handleHello).
   */
  reconnectToken: string
  /**
   * True when the slot was minted through the room's `expected` allocation —
   * the caller presented the matching slotToken. This is what lets the
   * /expect merge tell a token-bound seat from an open-claim holdover that
   * merely squatted an allocated guestId: only the former survives the
   * merge (F20). Absent on seats claimed before any allocation landed and on
   * slots persisted before this field existed.
   */
  viaExpect?: boolean
  lastReactionAt?: number
}

/** 128 bits of randomness, hex-encoded — the per-slot reconnect credential. */
function generateReconnectToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")
}

interface RoomState {
  game: string
  slots: Slot[]
  /**
   * Per-player join capabilities pushed by matchmaking when it pairs two
   * players into this room (pre-claim fix, 2026-10-08). When present, a
   * first `hello` must present the slotToken bound to its guestId — the
   * match response discloses BOTH guestIds, so a peer that connects first
   * could otherwise claim the opponent's id and lock them out. Rooms that
   * never received an allocation (invite links, direct room joins) keep
   * open guestId-claim semantics.
   */
  expected?: Record<
    string,
    {
      token: string
      role: "host" | "guest"
      /**
       * When the allocation armed this seat capability. Missing on entries
       * persisted before the seat deadline existed — the alarm backfills it
       * on first sight so a deploy cannot kill a match in flight.
       */
      armedAt?: number
    }
  >
}

/**
 * Socket identity carried across hibernation. Only `guestId` is ever read
 * back — the authoritative display name and role live in the room's slot
 * state, which is what the `welcome` / `peer-joined` frames are built from.
 */
interface ConnectionAttachment {
  guestId: string
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
    const url = new URL(request.url)
    // Internal allocation handoff from MatchmakingQueues. Publicly
    // unreachable: the Worker's router only forwards GET /room/{id}
    // upgrades, so a POST at this path can only arrive via a same-Worker
    // DO binding call — no shared secret is needed.
    if (request.method === "POST" && url.pathname === "/expect") {
      return this.handleExpect(request)
    }
    if (request.method === "POST" && url.pathname === "/cancel") {
      return this.handleCancel(request)
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", {
        status: 426,
        headers: corsHeaders(),
      })
    }

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
        if (type === "social_reaction") {
          const reaction = parsed as Record<string, unknown>
          const ids = [
            "hello",
            "good_luck",
            "nice_move",
            "wow",
            "oops",
            "thinking",
            "thanks",
            "good_game",
            "well_played",
            "rematch",
          ]
          if (
            Object.keys(reaction).some(
              (key) => key !== "type" && key !== "id" && key !== "protocol",
            ) ||
            (reaction.protocol !== undefined && reaction.protocol !== "gambit-deck:v1") ||
            typeof reaction.id !== "string" ||
            !ids.includes(reaction.id)
          )
            return
          const state = await this.loadState()
          const slot = state.slots.find((entry) => entry.guestId === attachment.guestId)
          if (!slot) return
          const now = Date.now()
          if (slot.lastReactionAt !== undefined && now - slot.lastReactionAt < 3000) return
          slot.lastReactionAt = now
          await this.saveState(state)
        }
        // Relay any other well-formed message verbatim to the other peer.
        // Each game owns its own protocol on top of the room envelope.
        this.broadcastExcept(ws, parsed)
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
    // Not a raw setAlarm(now + grace): that pushed an earlier slot's reap (or a
    // pending hello's 10 s deadline) out to this slot's later deadline (A-14).
    await this.scheduleRoomAlarm(state)

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
      // The alarm can fire for a reason that has nothing to do with this
      // slot — a pending socket's 10s hello timeout, say. Expire a slot only
      // once its OWN grace window has elapsed, otherwise that timeout deletes
      // a player who still has most of their 30s left to reclaim.
      if (slot.disconnectedAt + RECONNECT_GRACE_MS > now) return true
      removedGuestIds.push(slot.guestId)
      changed = true
      return false
    })

    // A reap that empties the room retires the allocation (F22): with nobody
    // seated the match is dead, and an armed `expected` would keep demanding
    // slotTokens nobody can still present — a refreshed client persists only
    // its reconnectToken — so the room would refuse every hello forever.
    // While a peer is still seated the map stays armed: a slotToken bearer
    // may still legitimately reclaim its reaped seat, and strangers must
    // keep being refused.
    if (removedGuestIds.length > 0 && state.slots.length === 0 && state.expected) {
      delete state.expected
    }

    // A matchmade seat that never fills is a player who never arrives: the
    // allocated peer's first connect failed or never ran, and nothing else
    // bounds the seated peer's wait (the ticket's poll already finished).
    // Expire the entry once its own armedAt deadline elapses; missing
    // armedAt backfills to now so the reap reaches pre-deadline allocations
    // one window later instead of at deploy time.
    let expectedExpired = false
    if (state.expected) {
      const claimed = new Set(state.slots.filter((s) => s.viaExpect === true).map((s) => s.guestId))
      for (const [guestId, entry] of Object.entries(state.expected)) {
        if (claimed.has(guestId)) continue
        if (entry.armedAt === undefined) {
          entry.armedAt = now
          changed = true
          continue
        }
        if (entry.armedAt + EXPECTED_SEAT_DEADLINE_MS > now) continue
        delete state.expected[guestId]
        expectedExpired = true
        changed = true
      }
      if (Object.keys(state.expected).length === 0) delete state.expected
    }

    // Fully retired room (storage hygiene): no seated players, no armed
    // allocations, no live sockets. Delete the persisted state so finished
    // games don't accumulate SQLite rows forever — loadState rebuilds the
    // default on next touch, so this is behavior-neutral.
    if (state.slots.length === 0 && !state.expected && sockets.length === 0) {
      await this.ctx.storage.delete(ROOM_STATE_KEY)
      await this.ctx.storage.deleteAlarm()
      return
    }

    if (changed) await this.saveState(state)

    // The next wake-up is the earliest REAL deadline still outstanding: a
    // slot's own grace expiry, or a pending handshake below. Re-deriving this
    // as `now + RECONNECT_GRACE_MS` on every wake-up pushed each slot's
    // deadline further out every time the alarm fired for anything else.
    const nextSlotDeadline = earliestSlotDeadline(state.slots, now)
    const nextExpectedDeadline = earliestExpectedDeadline(state.expected, state.slots, now)
    const nextAlarm = [nextPendingDeadline, nextSlotDeadline, nextExpectedDeadline]
      .filter((d): d is number => d !== null)
      .reduce<number | null>((min, d) => (min === null || d < min ? d : min), null)
    if (nextAlarm === null) {
      await this.ctx.storage.deleteAlarm()
    } else {
      await this.ctx.storage.setAlarm(nextAlarm)
    }

    if (!changed) return

    // Only broadcast peer-left if a slot was actually removed (not
    // when a peer reconnected within the grace period) or a matchmade seat
    // expired unfilled — the seated peer's match is dead either way, and
    // clients treat `expired` as the terminal room-dead signal.
    if (removedGuestIds.length > 0 || (expectedExpired && state.slots.length > 0)) {
      for (const ws of sockets) {
        this.safeSend(ws, JSON.stringify({ type: "peer-left", reason: "expired" }))
      }
    }
  }

  /**
   * Records the per-player join capabilities matchmaking issued when it
   * paired a room (pre-claim fix). Idempotent — retries overwrite the same
   * values, so a lost handoff can be re-pushed without corrupting live
   * slots. Refuses allocation only for a malformed body; never touches
   * existing slots.
   */
  private async handleExpect(request: Request): Promise<Response> {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return jsonResponse({ error: "invalid JSON" }, 400)
    }
    const slots = (body as { slots?: unknown })?.slots
    if (!Array.isArray(slots) || slots.length < 1 || slots.length > MAX_SLOTS) {
      return jsonResponse({ error: "slots must be a 1-2 entry array" }, 400)
    }
    const armedAt = Date.now()
    const parsed: Record<string, { token: string; role: "host" | "guest"; armedAt: number }> = {}
    for (const s of slots) {
      const e = s as { guestId?: unknown; token?: unknown; role?: unknown }
      if (
        typeof e?.guestId !== "string" ||
        e.guestId.length < 1 ||
        e.guestId.length > MAX_GUEST_ID_LENGTH ||
        typeof e?.token !== "string" ||
        e.token.length < 1 ||
        (e.role !== "host" && e.role !== "guest")
      ) {
        return jsonResponse({ error: "each slot needs guestId, token, role" }, 400)
      }
      parsed[e.guestId] = { token: e.token, role: e.role, armedAt }
    }
    const state = await this.loadState()
    const prior = state.expected ?? {}
    state.expected = { ...prior, ...parsed }

    // A pre-allocation seat under a guestId this push just minted — with the
    // allocated role — is the ticket-holder's own early hold (F20): `matched`
    // is withheld until this push lands, so nobody else can know the roomId,
    // and only the holder chose that guestId. Promote it in place instead of
    // evicting it — eviction tore a seat window where the matched peer's
    // first frames fanned out to zero sockets and the pair deadlocked
    // waiting for each other. Entries already in `prior` were disclosed by
    // an earlier push, so a seat under them gets no benefit of the doubt.
    // Every other seat not minted through a token is a squatter (F20):
    // evict it, and tell nobody — it was never a peer of record, and
    // announcing its departure only poisoned real seats (terminal forfeit).
    const evicted = new Set<string>()
    state.slots = state.slots.filter((slot) => {
      if (slot.viaExpect === true && state.expected?.[slot.guestId]) return true
      const minted = prior[slot.guestId] === undefined ? parsed[slot.guestId] : undefined
      if (minted && minted.role === slot.role) {
        slot.viaExpect = true
        return true
      }
      evicted.add(slot.guestId)
      return false
    })
    await this.saveState(state)

    if (evicted.size > 0) {
      for (const ws of this.ctx.getWebSockets()) {
        const att = ws.deserializeAttachment() as RoomAttachment | null
        if (att && !isPendingConnection(att) && evicted.has(att.guestId)) {
          try {
            ws.close(1008, "seat superseded by allocation")
          } catch {
            // already closing
          }
        }
      }
    }
    // An armed allocation needs its own wake-up: with zero sockets there are
    // no pending-handshake or slot deadlines, so nothing else ever schedules
    // the alarm that reaps a seat nobody claims.
    await this.scheduleRoomAlarm(state)
    return jsonResponse({ ok: true })
  }

  /**
   * A matched player cancelled on the matchmaking side (A-13). The match is
   * dead: retire the allocation and tell every other seated socket the room is
   * closed, so a peer that already connected stops waiting out the seat
   * deadline. Same internal-only reach as /expect.
   */
  private async handleCancel(request: Request): Promise<Response> {
    const guestId = ((await request.json().catch(() => null)) as { guestId?: unknown } | null)
      ?.guestId
    if (typeof guestId !== "string" || guestId.length < 1 || guestId.length > MAX_GUEST_ID_LENGTH) {
      return jsonResponse({ error: "guestId required" }, 400)
    }
    const state = await this.loadState()
    const sockets = this.ctx.getWebSockets()
    if (state.expected) {
      delete state.expected
      await this.saveState(state)
    }
    for (const ws of sockets) {
      const att = ws.deserializeAttachment() as RoomAttachment | null
      if (!att || isPendingConnection(att) || att.guestId === guestId) continue
      this.safeSend(ws, JSON.stringify({ type: "peer-left", reason: "closed" }))
    }
    if (state.slots.length === 0 && sockets.length === 0) {
      // Nothing left to keep: same hygiene as the alarm's fully-retired branch.
      await this.ctx.storage.delete(ROOM_STATE_KEY)
      await this.ctx.storage.deleteAlarm()
    } else {
      await this.scheduleRoomAlarm(state)
    }
    return jsonResponse({ ok: true })
  }

  private async handleHello(
    ws: WebSocket,
    msg: {
      guestId: string
      displayName?: string
      role?: unknown
      reconnectToken?: unknown
      slotToken?: unknown
    },
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
        // Legacy slot persisted before MM-01. These are real, not
        // hypothetical: the deployed Worker is still the 2026-09-15 upload
        // (STATE.md), so rooms created by it carry no credential at all.
        //
        // There is no credential to check here, and minting one hands the
        // pre-credential identity to whoever claims it first. "Uncontested"
        // only meant no socket was attached — which is exactly the state a
        // legitimate player is in while reconnecting, and the opponent
        // learns guestId from welcome/peer-joined, so the first claimant is
        // frequently not the owner.
        //
        // So the identity is retired rather than migrated: the slot is
        // dropped and the caller is told to rejoin as a new player. A fresh
        // join always mints a credential, so the legacy population drains
        // instead of being handed out. Bounded cost: a room that is live
        // across the MM-01 deploy and whose player reconnects has to start
        // over, rather than silently losing the seat to the other peer.
        state.slots = state.slots.filter((s) => s !== existing)
        await this.saveState(state)
        for (const other of this.ctx.getWebSockets()) {
          // Not to the rejected socket — it gets the error below, and a
          // peer-left frame would only be noise on a connection being closed.
          if (other === ws) continue
          this.safeSend(other, JSON.stringify({ type: "peer-left", reason: "expired" }))
        }
        this.sendError(ws, "invalid", "legacy slot expired — rejoin as a new player")
        ws.close(1008, "reconnect rejected")
        return
      }
      if (presented === null || !secretsMatch(presented, existing.reconnectToken)) {
        this.sendError(ws, "invalid", "reconnect credential required")
        ws.close(1008, "reconnect rejected")
        return
      }
      existing.disconnectedAt = null
      existing.displayName = displayName
      slot = existing
      isReconnect = true
    } else {
      // Pre-claim binding (F-new-room-initial-slot-auth-2026-10-03): a
      // matchmade room knows which guestIds matchmaking allocated and holds
      // a private slotToken per player. A first hello must present the
      // matching token — the disclosed guestId alone is not a capability.
      // Unallocated rooms (invite links) keep open claim semantics.
      const expected = state.expected?.[msg.guestId]
      if (state.expected) {
        const presented = typeof msg.slotToken === "string" ? msg.slotToken : null
        if (!expected || presented === null || !secretsMatch(presented, expected.token)) {
          this.sendError(ws, "invalid", "join capability required")
          ws.close(1008, "join refused")
          return
        }
      }
      if (state.slots.length >= MAX_SLOTS) {
        this.sendError(ws, "unknown", "room full")
        ws.close(1013, "room full")
        return
      }

      let role: "host" | "guest" =
        expected?.role ?? requestedRole ?? (state.slots.length === 0 ? "host" : "guest")
      const takenRoles = new Set(state.slots.map((s) => s.role))
      // A caller that NAMED a role in an open room wants exactly that seat. Seating
      // it as the other role announced a stranger to the real holder and ended the
      // room when the "guest" left, so refuse before welcome (and before any
      // peer-joined). An allocated room is decided by the slotToken, not the hint;
      // a hello naming no role keeps first-come seating below.
      if (!expected && requestedRole && takenRoles.has(requestedRole)) {
        this.sendError(ws, "role-taken", "That room code is already in use")
        ws.close(1008, "role taken")
        return
      }
      // No role named: if first-come lands on a taken seat, take the other one.
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
        // Reaching this point while an allocation is armed means the
        // slotToken check above passed — the seat is token-bound and
        // survives an /expect merge eviction (F20).
        viaExpect: state.expected !== undefined,
      }
      state.slots.push(slot)
    }

    await this.saveState(state)

    ws.serializeAttachment({ guestId: slot.guestId })
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

  private broadcastExcept(except: WebSocket, msg: unknown): void {
    const str = JSON.stringify(msg)
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue
      // A socket that has not said hello is not a player yet (A-15).
      const att = ws.deserializeAttachment() as RoomAttachment | null
      if (!att || isPendingConnection(att)) continue
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
    // Earliest outstanding slot grace, not `now + grace` — see the alarm
    // handler. Re-arming from `now` on every close pushed a slot's real
    // expiry outwards each time anything else touched the alarm.
    let nextAlarm = earliestSlotDeadline(state.slots, now)

    const nextExpectedDeadline = earliestExpectedDeadline(state.expected, state.slots, now)
    if (nextExpectedDeadline !== null) {
      nextAlarm =
        nextAlarm === null ? nextExpectedDeadline : Math.min(nextAlarm, nextExpectedDeadline)
    }

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
