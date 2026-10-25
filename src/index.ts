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
  /**
   * When the ticket first collected `matched`. The record then lingers only a
   * short tombstone (a retried poll still gets its answer) instead of the full
   * match window (A-06/A-07).
   */
  collectedAt?: number
}

interface Player {
  ticket: string
  peerId: string
  roomId: string
  displayName: string
  guestId: string
  /** Last activity — refreshed by polls/rejoins; drives the 30s timeout. */
  joinedAt: number
  /**
   * First join — never refreshed. Polling extends `joinedAt` forever, so
   * without this absolute bound a waiting ticket can live (and grow queue
   * state) indefinitely (F-new-queue-state-unbounded-2026-10-04). Entries
   * persisted before this field existed fall back to `joinedAt`.
   */
  createdAt?: number
  /** Client address at join time; bounds how many live entries one address holds. */
  ip?: string
}

interface QueueState {
  queues: Record<string, Player[]>
  matches: Record<string, MatchRecord>
  /** Persisted by earlier builds; dropped on load — the counters live in memory now. */
  rateLimits?: unknown
}

const QUEUE_KEY = "queue-state"
const QUEUE_TIMEOUT_MS = 30_000
const MAX_TICKET_AGE_MS = 600_000
const MAX_QUEUE_LENGTH = 100
const MAX_ENTRIES_PER_IP = 3
/**
 * A queued player pairs only if it was seen this recently. Gambit polls every
 * 500 ms and tic-tac-toe at most every 4 s, so 10 s is two slow intervals; the
 * 30 s TTL alone left a closed tab matchable for up to 30 s (A-05).
 */
const PAIRING_FRESHNESS_MS = 10_000
const MATCH_TIMEOUT_MS = 90_000
const COLLECTED_MATCH_TTL_MS = 15_000
const MAX_MATCH_RECORDS = 400
const JOIN_RATE_WINDOW_MS = 60_000
const MAX_JOIN_ATTEMPTS_PER_WINDOW = 20
const MAX_RATE_LIMIT_ENTRIES = 512

/** A queue entry is live while recently polled AND within its absolute age. */
function isLiveTicket(p: Player, now: number): boolean {
  return (
    now - p.joinedAt < QUEUE_TIMEOUT_MS && now - (p.createdAt ?? p.joinedAt) < MAX_TICKET_AGE_MS
  )
}

/**
 * Drop match records whose match window has elapsed, or whose tombstone has
 * (a collected record only lingers COLLECTED_MATCH_TTL_MS). Mutates `state` and
 * reports whether anything was removed, so the caller decides whether the
 * pruned state still needs persisting.
 */
function pruneExpiredMatches(state: QueueState, now: number): boolean {
  let changed = false
  for (const [ticket, match] of Object.entries(state.matches)) {
    const tombstoneOver =
      match.collectedAt !== undefined && now - match.collectedAt > COLLECTED_MATCH_TTL_MS
    if (tombstoneOver || now - match.createdAt > MATCH_TIMEOUT_MS) {
      delete state.matches[ticket]
      changed = true
    }
  }
  return changed
}

/** Keeps the persisted blob bounded under a burst of matches: oldest records go first. */
function capMatchRecords(state: QueueState): void {
  const tickets = Object.keys(state.matches)
  if (tickets.length <= MAX_MATCH_RECORDS) return
  tickets.sort((a, b) => state.matches[a].createdAt - state.matches[b].createdAt)
  for (const ticket of tickets.slice(0, tickets.length - MAX_MATCH_RECORDS)) {
    delete state.matches[ticket]
  }
}

export class MatchmakingQueues extends DurableObject {
  /**
   * Join counters per address, in memory only. shortcut: a DO restart (eviction,
   * deploy) resets them, which only hands out a fresh window; persisting them
   * rewrote the whole queue blob on every join. Upgrade to a Rate Limiting
   * binding if the counters must survive restarts.
   */
  private joinCounters = new Map<string, { count: number; windowStartedAt: number }>()

  /**
   * When each queued ticket was last seen (join or poll). In memory only: the
   * persisted `joinedAt` is refreshed at most every 15 s, far too coarse, and a
   * write per poll would be a lot of traffic. After a DO restart a ticket falls
   * back to `joinedAt`, so it can be skipped until its next poll (<= 4 s).
   */
  private lastSeen = new Map<string, number>()

  private isFresh(p: Player, now: number): boolean {
    return now - (this.lastSeen.get(p.ticket) ?? p.joinedAt) < PAIRING_FRESHNESS_MS
  }

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
    if (!stored) return { queues: {}, matches: {} }
    delete stored.rateLimits
    return stored
  }

  private async saveState(state: QueueState): Promise<void> {
    await this.ctx.storage.put(QUEUE_KEY, state)
  }

  private async getQueue(game: string): Promise<Player[]> {
    const state = await this.loadState()
    const now = Date.now()
    const queue = (state.queues[game] ?? []).filter((p) => isLiveTicket(p, now))
    if (queue.length !== (state.queues[game] ?? []).length) {
      state.queues[game] = queue
      await this.saveState(state)
    }
    return queue
  }

  private async getMatches(): Promise<Record<string, MatchRecord>> {
    const state = await this.loadState()
    const now = Date.now()
    if (pruneExpiredMatches(state, now)) {
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
    const rateLimit = this.consumeJoinAttempt(request, now)
    if (rateLimit) return rateLimit
    const state = await this.loadState()

    const ticket = generateTicket()
    const roomId = generateRoomId()

    const player: Player = {
      ticket,
      peerId: req.peerId,
      roomId,
      displayName: sanitizeDisplayName(req.displayName),
      guestId: req.guestId ?? crypto.randomUUID(),
      joinedAt: now,
      createdAt: now,
      ip: clientIp(request),
    }

    // Prune expired matches and queue entries, and drop any live entry of the
    // same player. A repeat join (known peerId OR guestId — a refresh that lost
    // the ticket) SUPERSEDES the old entry with a fresh ticket and roomId. The
    // stored ticket is never handed back: peerId and guestId reach every
    // opponent in the match payload, so answering with the ticket let anyone who
    // knew one take over or cancel that player's search (A-02). It also keeps
    // the queue to one entry per guestId, so one client cannot fill it (A-03).
    // Residual: whoever knows a peerId can cancel that player's search by
    // re-joining, bounded by the join rate limit.
    pruneExpiredMatches(state, now)
    const queue = (state.queues[game] ?? []).filter(
      (p) => isLiveTicket(p, now) && p.peerId !== player.peerId && p.guestId !== player.guestId,
    )

    if (queue.length >= MAX_QUEUE_LENGTH) {
      return jsonResponse({ error: "queue full — retry shortly" }, 503, {
        "Retry-After": "30",
      })
    }
    // Entries only pile up unpaired, so 3 per address still lets a shared NAT
    // play (its players pair with each other) while one address cannot hold the
    // queue. Checked before pairing, like the cap above (A-03).
    if (queue.filter((p) => p.ip === player.ip).length >= MAX_ENTRIES_PER_IP) {
      return jsonResponse({ error: "too many active searches from this address" }, 429, {
        "Retry-After": "30",
      })
    }

    // Only ticket-holders still in the queue need a lastSeen entry.
    for (const t of this.lastSeen.keys()) {
      if (!queue.some((p) => p.ticket === t)) this.lastSeen.delete(t)
    }
    const opponent = queue.find((p) => this.isFresh(p, now))
    if (opponent) {
      this.lastSeen.delete(opponent.ticket)
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
      capMatchRecords(state)
      await this.saveState(state)
      const bound = await this.bindRoomSlots(match.roomId, match, slots)
      if (!bound) {
        // Fail closed: keep the joiner polling; the retry path in
        // handlePoll re-pushes until the room acknowledges or the match
        // times out. A matched response before the room is bound would
        // reopen the pre-claim hole this commit exists to close.
        return jsonResponse({ status: "waiting", ticket, roomId })
      }
      // The bind await opened the input gate: polls, leaves and other joins ran
      // against storage while this request waited, so `state` is stale and
      // saving it would undo their writes (A-01). Re-read and touch only the
      // match records, and only those that still exist.
      const current = await this.loadState()
      const hostRecord = current.matches[opponent.ticket]
      if (hostRecord) hostRecord.slotsBound = true
      if (!current.matches[player.ticket]) {
        // The host left while the room was binding (F39): honour it. Queue the
        // joiner as a fresh arrival rather than announcing a match with nobody.
        // shortcut: not re-paired against others queued meanwhile, so it waits
        // for the next join; upgrade if pairing ever moves off join time.
        const live = (current.queues[game] ?? []).filter((p) => isLiveTicket(p, Date.now()))
        current.queues[game] = [...live, player]
        this.lastSeen.set(ticket, Date.now())
        await this.saveState(current)
        return jsonResponse({ status: "waiting", ticket, roomId })
      }
      // The joiner collects its match in this very response and never learns its
      // ticket, so nothing can poll that record: drop it now (A-07). The host's
      // record stays until the host collects.
      delete current.matches[player.ticket]
      await this.saveState(current)
      return jsonResponse({
        status: "matched",
        match: { ...match, role: "guest", game, createdAt: now },
        slotToken: slots.guest,
      })
    }

    state.queues[game] = [...queue, player]
    this.lastSeen.set(ticket, now)
    await this.saveState(state)
    return jsonResponse({ status: "waiting", ticket, roomId })
  }

  private consumeJoinAttempt(request: Request, now: number): Response | null {
    const ip = clientIp(request)
    const counters = this.joinCounters
    for (const [key, entry] of counters) {
      if (now - entry.windowStartedAt >= JOIN_RATE_WINDOW_MS) counters.delete(key)
    }
    // Bound the map's high-cardinality tail: past the cap, drop the oldest
    // windows. Bounded pruning work, and worst case an evicted IP's counter
    // simply restarts — it does not widen anyone's allowance.
    if (counters.size > MAX_RATE_LIMIT_ENTRIES) {
      const oldestFirst = [...counters].sort((a, b) => a[1].windowStartedAt - b[1].windowStartedAt)
      for (const [key] of oldestFirst.slice(0, counters.size - MAX_RATE_LIMIT_ENTRIES)) {
        counters.delete(key)
      }
    }

    const current = counters.get(ip)
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
      counters.set(ip, { count: 1, windowStartedAt: now })
    }
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
    const now = Date.now()
    let state = await this.loadState()
    if (pruneExpiredMatches(state, now)) await this.saveState(state)
    const match = state.matches[ticket]
    if (match) {
      let dirty = false
      // Records persisted before the slot-capability deploy carry no `slots`
      // — treat them as open-mode (the room was never allocated) rather than
      // stalling them behind a binding that can never exist.
      if (match.slots && match.slotsBound !== true) {
        const bound = await this.bindRoomSlots(match.roomId, match, match.slots)
        if (!bound) {
          return jsonResponse({ status: "waiting", ticket, roomId: match.roomId })
        }
        // Re-read: the bind await let a leave or a prune delete this record,
        // and a match that no longer exists must not be disclosed (A-01).
        state = await this.loadState()
        if (!state.matches[ticket]) return jsonResponse({ error: "ticket not found" }, 404)
        state.matches[ticket].slotsBound = true
        dirty = true
      }
      const record = state.matches[ticket]
      // First collection starts the short tombstone: a retried poll still gets
      // its answer, but the record no longer lingers for the full window (A-07).
      if (record.collectedAt === undefined) {
        record.collectedAt = now
        dirty = true
      }
      if (dirty) await this.saveState(state)
      const { slots, slotsBound, collectedAt, ...pub } = record
      return jsonResponse({
        status: "matched",
        match: pub,
        ...(slots ? { slotToken: slots[record.role] } : {}),
      })
    }

    const queue = (state.queues[game] ?? []).filter((p) => isLiveTicket(p, now))
    const player = queue.find((p) => p.ticket === ticket)
    if (!player) {
      return jsonResponse({ error: "ticket not found" }, 404)
    }

    this.lastSeen.set(ticket, now)
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
    this.lastSeen.delete(ticket)
    const state = await this.loadState()

    const queue = state.queues[game] ?? []
    const filteredQueue = queue.filter((p) => isLiveTicket(p, now) && p.ticket !== ticket)
    if (filteredQueue.length !== queue.length) {
      state.queues[game] = filteredQueue
    }

    pruneExpiredMatches(state, now)

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
    // A match is one room, however many ticket records still reference it.
    const rooms = new Set(
      Object.values(await this.getMatches())
        .filter((m) => m.game === game)
        .map((m) => m.roomId),
    )
    return jsonResponse({
      ok: true,
      game,
      waiting: queue.length,
      matches: rooms.size,
      players: queue.length + 2 * rooms.size,
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

function clientIp(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("X-Forwarded-For")?.split(",", 1)[0]?.trim() ??
    "unknown"
  )
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
