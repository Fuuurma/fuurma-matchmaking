import { DurableObject } from "cloudflare:workers"
import { GameRoomDO } from "./room"
import {
  ALLOWED_GAMES,
  corsHeaders,
  isValidRoomId,
  jsonResponse,
  logEvent,
  MAX_DISPLAY_NAME_UTF8_BYTES,
  MAX_GUEST_ID_LENGTH,
  MAX_JSON_BODY_BYTES,
  MAX_PEER_ID_LENGTH,
  sanitizeDisplayName,
  utf8ByteLength,
} from "./utils"

export { GameRoomDO }

export interface MatchmakingRequest {
  game: string
  peerId: string
  displayName?: string
  guestId?: string
}

export interface Match {
  roomId: string
  host: {
    peerId: string
    displayName: string
    guestId: string
  }
  guest: {
    peerId: string
    displayName: string
    guestId: string
  }
}

type MatchWithRole = Match & { role: "host" | "guest"; game: string; createdAt: number }

/**
 * Stored per-ticket match record. `slots` carries BOTH players' join
 * capabilities (pre-claim fix, 2026-10-08) so a poll retry can re-push the
 * room allocation if the first DO→DO handoff failed; the response surface
 * only ever exposes the poller's own token. `slotsBound` records that the
 * GameRoomDO acknowledged the allocation — until then the room has open
 * semantics, so a matched response is withheld while unbound.
 */
type MatchRecord = MatchWithRole & {
  slots?: { host: string; guest: string }
  slotsBound?: boolean
}

export type MatchmakingResponse =
  | { status: "waiting"; ticket: string; roomId: string }
  | { status: "matched"; match: MatchWithRole; slotToken: string }

interface Player {
  ticket: string
  peerId: string
  roomId: string
  displayName: string
  guestId: string
  joinedAt: number
}

interface QueueState {
  queues: Record<string, Player[]>
  matches: Record<string, MatchRecord>
  rateLimits?: Record<string, { count: number; windowStartedAt: number }>
}

const QUEUE_KEY = "queue-state"
const QUEUE_TIMEOUT_MS = 30_000
const MATCH_TIMEOUT_MS = 300_000
const JOIN_RATE_WINDOW_MS = 60_000
const MAX_JOIN_ATTEMPTS_PER_WINDOW = 20

export class MatchmakingQueues extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() })
    }

    const parsed = path.match(/^\/api\/matchmaking\/([^/]+)(?:\/(.+))?$/)
    if (!parsed) {
      return jsonResponse({ error: "not found" }, 404)
    }

    const game = parsed[1]
    const action = parsed[2] ?? ""

    if (!ALLOWED_GAMES.has(game)) {
      return jsonResponse({ error: "unknown game" }, 400)
    }

    try {
      if (request.method === "POST" && action === "join") {
        const body = await parseJson(request)
        if (!body.ok) return body.response
        return await this.handleJoin(game, body.value, request)
      }

      if (request.method === "GET" && action === "poll") {
        const ticket = url.searchParams.get("ticket")
        if (!ticket) return jsonResponse({ error: "ticket required" }, 400)
        if (!isValidTicket(ticket)) {
          return jsonResponse({ error: "valid ticket required" }, 400)
        }
        return this.handlePoll(game, ticket)
      }

      if (request.method === "POST" && action === "leave") {
        const body = await parseJson(request)
        if (!body.ok) return body.response
        if (!body.value || typeof body.value !== "object" || Array.isArray(body.value)) {
          return jsonResponse({ error: "object body required" }, 400)
        }
        const ticket = (body.value as { ticket?: unknown }).ticket
        if (typeof ticket !== "string" || !isValidTicket(ticket)) {
          return jsonResponse({ error: "valid ticket required" }, 400)
        }
        return this.handleLeave(game, ticket)
      }

      if (request.method === "GET" && action === "health") {
        return this.handleHealth(game)
      }

      return jsonResponse({ error: "not found" }, 404)
    } catch (err) {
      const message = err instanceof Error ? err.message : "server error"
      logEvent("error", "matchmaking_request_failed", { game, action, message })
      return jsonResponse({ error: message }, 500)
    }
  }

  private async loadState(): Promise<QueueState> {
    const stored = await this.ctx.storage.get<QueueState>(QUEUE_KEY)
    return stored ?? { queues: {}, matches: {} }
  }

  private async saveState(state: QueueState): Promise<void> {
    await this.ctx.storage.put(QUEUE_KEY, state)
  }

  private async getQueue(game: string): Promise<Player[]> {
    const state = await this.loadState()
    const now = Date.now()
    const queue = (state.queues[game] ?? []).filter((p) => now - p.joinedAt < QUEUE_TIMEOUT_MS)
    if (queue.length !== (state.queues[game] ?? []).length) {
      state.queues[game] = queue
      await this.saveState(state)
    }
    return queue
  }

  private async getMatches(): Promise<Record<string, MatchRecord>> {
    const state = await this.loadState()
    const now = Date.now()
    const before = Object.keys(state.matches).length
    for (const ticket of Object.keys(state.matches)) {
      if (now - state.matches[ticket].createdAt > MATCH_TIMEOUT_MS) {
        delete state.matches[ticket]
      }
    }
    if (Object.keys(state.matches).length !== before) {
      await this.saveState(state)
    }
    return state.matches
  }

  private async handleJoin(game: string, body: unknown, request: Request): Promise<Response> {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return jsonResponse({ error: "object body required" }, 400)
    }
    const req = body as Partial<MatchmakingRequest>
    if (
      typeof req.peerId !== "string" ||
      req.peerId.length < 1 ||
      req.peerId.length > MAX_PEER_ID_LENGTH
    ) {
      return jsonResponse({ error: `peerId required (1-${MAX_PEER_ID_LENGTH} chars)` }, 400)
    }
    if (
      req.guestId !== undefined &&
      (typeof req.guestId !== "string" ||
        req.guestId.length < 1 ||
        req.guestId.length > MAX_GUEST_ID_LENGTH)
    ) {
      return jsonResponse({ error: `guestId must be 1-${MAX_GUEST_ID_LENGTH} chars` }, 400)
    }
    if (req.displayName !== undefined) {
      if (typeof req.displayName !== "string") {
        return jsonResponse({ error: "displayName must be a string" }, 400)
      }
      // Bound the raw payload by UTF-8 byte length (per the validation
      // contract). This prevents a malicious client from submitting a
      // name whose `.length` (UTF-16 code units) is small but whose
      // UTF-8 byte count is large (e.g. 100 emoji = 200 .length /
      // 400 bytes). The same `.length`-only check used for opaque IDs
      // would accept up to ~1024 bytes per 4-byte glyph before tripping,
      // letting crafted payloads inflate stored names.
      if (utf8ByteLength(req.displayName) > MAX_DISPLAY_NAME_UTF8_BYTES) {
        return jsonResponse(
          { error: `displayName must be at most ${MAX_DISPLAY_NAME_UTF8_BYTES} UTF-8 bytes` },
          400,
        )
      }
    }

    const now = Date.now()
    const state = await this.loadState()
    const rateLimit = await this.consumeJoinAttempt(state, request, now)
    if (rateLimit) return rateLimit

    // Prune expired queue entries and matches in one pass.
    const queue = (state.queues[game] ?? []).filter((p) => now - p.joinedAt < QUEUE_TIMEOUT_MS)
    for (const ticket of Object.keys(state.matches)) {
      if (now - state.matches[ticket].createdAt > MATCH_TIMEOUT_MS) {
        delete state.matches[ticket]
      }
    }

    const ticket = generateTicket()
    const roomId = generateRoomId()

    const player: Player = {
      ticket,
      peerId: req.peerId,
      roomId,
      displayName: sanitizeDisplayName(req.displayName),
      guestId: req.guestId ?? crypto.randomUUID(),
      joinedAt: now,
    }

    // Guard: one active queue entry per peerId. If the same player re-joins
    // (e.g. lost their ticket and retried), return their existing waiting
    // ticket instead of creating a duplicate queue entry. Refresh joinedAt
    // so the 30s queue timeout resets on each rejoin attempt.
    const existingEntry = queue.find((p) => p.peerId === player.peerId)
    if (existingEntry) {
      existingEntry.joinedAt = now
      state.queues[game] = queue
      await this.saveState(state)
      logEvent("warn", "duplicate_join_returned_existing", {
        game,
        peerId: player.peerId.slice(0, 8),
      })
      return jsonResponse({
        status: "waiting",
        ticket: existingEntry.ticket,
        roomId: existingEntry.roomId,
      })
    }

    const opponent = queue.find((p) => p.guestId !== player.guestId && p.peerId !== player.peerId)
    if (opponent) {
      state.queues[game] = queue.filter((p) => p.ticket !== opponent.ticket)
      const match: Match = {
        roomId: opponent.roomId,
        host: {
          peerId: opponent.peerId,
          displayName: opponent.displayName,
          guestId: opponent.guestId,
        },
        guest: {
          peerId: player.peerId,
          displayName: player.displayName,
          guestId: player.guestId,
        },
      }
      const matchWithRole = { ...match, game, createdAt: now }
      // Per-player join capabilities (pre-claim fix): matchmaking issues a
      // private slotToken per player and hands the allocation to the room
      // DO before the match is disclosed. The response only carries the
      // joiner's own token — the opponent's stays in the stored record.
      const slots = { host: generateTicket(), guest: generateTicket() }
      state.matches[opponent.ticket] = { ...matchWithRole, role: "host", slots }
      state.matches[player.ticket] = { ...matchWithRole, role: "guest", slots }
      await this.saveState(state)
      const bound = await this.bindRoomSlots(match.roomId, match, slots)
      if (!bound) {
        // Fail closed: keep the joiner polling; the retry path in
        // handlePoll re-pushes until the room acknowledges or the match
        // times out. A matched response before the room is bound would
        // reopen the pre-claim hole this commit exists to close.
        return jsonResponse({ status: "waiting", ticket, roomId })
      }
      state.matches[opponent.ticket].slotsBound = true
      state.matches[player.ticket].slotsBound = true
      await this.saveState(state)
      return jsonResponse({
        status: "matched",
        match: { ...match, role: "guest", game, createdAt: now },
        slotToken: slots.guest,
      })
    }

    state.queues[game] = [...queue, player]
    await this.saveState(state)
    return jsonResponse({ status: "waiting", ticket, roomId })
  }

  private async consumeJoinAttempt(
    state: QueueState,
    request: Request,
    now: number,
  ): Promise<Response | null> {
    const ip =
      request.headers.get("CF-Connecting-IP") ??
      request.headers.get("X-Forwarded-For")?.split(",", 1)[0]?.trim() ??
      "unknown"
    const rateLimits = state.rateLimits ?? {}
    for (const [key, entry] of Object.entries(rateLimits)) {
      if (now - entry.windowStartedAt >= JOIN_RATE_WINDOW_MS) delete rateLimits[key]
    }

    const current = rateLimits[ip]
    if (current && now - current.windowStartedAt < JOIN_RATE_WINDOW_MS) {
      if (current.count >= MAX_JOIN_ATTEMPTS_PER_WINDOW) {
        return jsonResponse({ error: "too many join attempts" }, 429, {
          "Retry-After": String(
            Math.ceil((JOIN_RATE_WINDOW_MS - (now - current.windowStartedAt)) / 1000),
          ),
        })
      }
      current.count += 1
    } else {
      rateLimits[ip] = { count: 1, windowStartedAt: now }
    }

    state.rateLimits = rateLimits
    await this.saveState(state)
    return null
  }

  /**
   * Pushes the match's slot allocation to the GameRoomDO for `roomId`.
   * Idempotent — the DO merges entries — so callers retry freely. Returns
   * false on any failure; callers must NOT disclose the match while unbound
   * (an unbound room has open claim semantics, which is the pre-claim hole).
   */
  private async bindRoomSlots(
    roomId: string,
    match: Match,
    slots: { host: string; guest: string },
  ): Promise<boolean> {
    try {
      const stub = this.env.GAME_ROOM.get(this.env.GAME_ROOM.idFromName(roomId))
      const res = await stub.fetch(
        new Request("https://room.internal/expect", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            slots: [
              { guestId: match.host.guestId, token: slots.host, role: "host" },
              { guestId: match.guest.guestId, token: slots.guest, role: "guest" },
            ],
          }),
        }),
      )
      return res.ok
    } catch {
      return false
    }
  }

  private async handlePoll(game: string, ticket: string): Promise<Response> {
    const matches = await this.getMatches()
    const match = matches[ticket]
    if (match) {
      // Records persisted before the slot-capability deploy carry no `slots`
      // — treat them as open-mode (the room was never allocated) rather than
      // stalling them behind a binding that can never exist.
      if (match.slots && match.slotsBound !== true) {
        const bound = await this.bindRoomSlots(match.roomId, match, match.slots)
        if (!bound) {
          return jsonResponse({ status: "waiting", ticket, roomId: match.roomId })
        }
        const state = await this.loadState()
        const stored = state.matches[ticket]
        if (stored) {
          stored.slotsBound = true
          await this.saveState(state)
        }
      }
      const { slots, slotsBound, ...pub } = match
      return jsonResponse({
        status: "matched",
        match: pub,
        ...(slots ? { slotToken: slots[match.role] } : {}),
      })
    }

    const now = Date.now()
    const state = await this.loadState()
    const queue = (state.queues[game] ?? []).filter((p) => now - p.joinedAt < QUEUE_TIMEOUT_MS)
    const player = queue.find((p) => p.ticket === ticket)
    if (!player) {
      return jsonResponse({ error: "ticket not found" }, 404)
    }

    // Refresh joinedAt on each poll so actively-polling players don't
    // time out. The 30s queue timeout is for cleaning up abandoned
    // entries, not for limiting how long someone can wait for a match.
    if (now - player.joinedAt > QUEUE_TIMEOUT_MS / 2) {
      player.joinedAt = now
      state.queues[game] = queue
      await this.saveState(state)
    }

    return jsonResponse({ status: "waiting", ticket, roomId: player.roomId })
  }

  private async handleLeave(game: string, ticket: string): Promise<Response> {
    const now = Date.now()
    const state = await this.loadState()

    const queue = state.queues[game] ?? []
    const filteredQueue = queue.filter(
      (p) => now - p.joinedAt < QUEUE_TIMEOUT_MS && p.ticket !== ticket,
    )
    if (filteredQueue.length !== queue.length) {
      state.queues[game] = filteredQueue
    }

    for (const t of Object.keys(state.matches)) {
      if (now - state.matches[t].createdAt > MATCH_TIMEOUT_MS) {
        delete state.matches[t]
      }
    }

    const match = state.matches[ticket]
    if (match) {
      for (const t of Object.keys(state.matches)) {
        if (
          t !== ticket &&
          state.matches[t].roomId === match.roomId &&
          state.matches[t].game === match.game
        ) {
          delete state.matches[t]
          break
        }
      }
      delete state.matches[ticket]
    }

    await this.saveState(state)
    return jsonResponse({ status: "left" })
  }

  private async handleHealth(game: string): Promise<Response> {
    const queue = await this.getQueue(game)
    const matches = Object.values(await this.getMatches()).filter((m) => m.game === game)
    return jsonResponse({
      ok: true,
      game,
      waiting: queue.length,
      matches: matches.length,
    })
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/") {
      return jsonResponse({ ok: true, service: "fuurma-matchmaking" })
    }

    // WebSocket relay route: /room/{roomId}
    if (request.method === "GET" && url.pathname.startsWith("/room/")) {
      const roomId = url.pathname.slice("/room/".length)
      if (!isValidRoomId(roomId)) {
        return jsonResponse({ error: "invalid room id" }, 400)
      }
      const id = env.GAME_ROOM.idFromName(roomId)
      const stub = env.GAME_ROOM.get(id)
      return stub.fetch(request)
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() })
    }

    const match = url.pathname.match(/^\/api\/matchmaking\/([^/]+)(?:\/(.+))?$/)
    if (!match) {
      return jsonResponse({ error: "not found" }, 404)
    }

    const game = match[1]
    if (!ALLOWED_GAMES.has(game)) {
      return jsonResponse({ error: "unknown game" }, 400)
    }

    const id = env.MATCHMAKING_QUEUES.idFromName(game)
    const stub = env.MATCHMAKING_QUEUES.get(id)
    const response = await stub.fetch(request)

    // Inject wsUrl into matched responses so the client can connect directly.
    const contentType = response.headers.get("Content-Type") ?? ""
    if (response.ok && contentType.includes("application/json")) {
      try {
        const cloned = response.clone()
        const body = (await cloned.json()) as Record<string, unknown> | null
        if (
          body &&
          typeof body === "object" &&
          "match" in body &&
          body.match &&
          typeof body.match === "object"
        ) {
          const match = body.match as Record<string, unknown>
          if (typeof match.roomId === "string" && typeof match.wsUrl !== "string") {
            match.wsUrl = buildWsUrl(request.url, match.roomId)
            // Build fresh headers — the original Content-Length is now stale
            // because we added the wsUrl field, and reusing it would truncate
            // the response body.
            const headers = new Headers()
            headers.set("Content-Type", "application/json")
            for (const [key, value] of Object.entries(corsHeaders())) {
              headers.set(key, value)
            }
            return new Response(JSON.stringify(body), {
              status: response.status,
              headers,
            })
          }
        }
      } catch {
        // not JSON; return original
      }
    }

    return response
  },
}

function buildWsUrl(requestUrl: string, roomId: string): string {
  const u = new URL(`/room/${roomId}`, requestUrl)
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:"
  return u.toString()
}

function isValidTicket(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value)
}

async function parseJson(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const tooLarge = () => jsonResponse({ error: "request body too large" }, 413)
  // Declared-length fast path: reject without reading a byte. An absent or
  // unparseable length falls through to stream enforcement below.
  const declared = request.headers.get("content-length")
  if (declared != null && /^\d+$/.test(declared.trim()) && Number(declared) > MAX_JSON_BODY_BYTES) {
    return { ok: false, response: tooLarge() }
  }
  // Stream-enforced read: a false small (or missing) Content-Length cannot
  // bypass the cap. Stops at the limit instead of buffering the full body.
  try {
    const body = request.body
    if (!body) return { ok: false, response: jsonResponse({ error: "invalid json" }, 400) }
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value?.byteLength ?? 0
      if (total > MAX_JSON_BODY_BYTES) {
        await reader.cancel().catch(() => {})
        return { ok: false, response: tooLarge() }
      }
      if (value) chunks.push(value)
    }
    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    const text = new TextDecoder().decode(merged)
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false, response: jsonResponse({ error: "invalid json" }, 400) }
  }
}

function generateTicket(): string {
  // 128 bits of cryptographic randomness (MM-02): the old timestamp +
  // 8-hex-char suffix left only 32 unpredictable bits on a Bearer [REDACTED] used
  // by poll/leave. Clients treat tickets as opaque strings.
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")
}

function generateRoomId(): string {
  // 128-bit room locator (MM-01): the old 8-hex-char id held 32 random bits.
  // 32 chars stays inside the 4-64 client room-id contract.
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return [...bytes]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()
}
