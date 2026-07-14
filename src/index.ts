import { DurableObject } from "cloudflare:workers"
import { GameRoomDO } from "./room"

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

export type MatchmakingResponse =
  | { status: "waiting"; ticket: string; roomId: string }
  | { status: "matched"; match: MatchWithRole }

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
  matches: Record<string, MatchWithRole>
}

const QUEUE_KEY = "queue-state"
const QUEUE_TIMEOUT_MS = 30_000
const MATCH_TIMEOUT_MS = 300_000
const ALLOWED_GAMES = new Set(["tictactoe", "uno-chess"])

export class MatchmakingQueues extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() })
    }

    const match = path.match(/^\/api\/matchmaking\/([^/]+)(?:\/(.+))?$/)
    if (!match) {
      return jsonResponse({ error: "not found" }, 404)
    }

    const game = match[1]
    const action = match[2] ?? ""

    try {
      if (request.method === "POST" && action === "join") {
        return await this.handleJoin(game, await request.json())
      }

      if (request.method === "GET" && action === "poll") {
        const ticket = url.searchParams.get("ticket")
        if (!ticket) return jsonResponse({ error: "ticket required" }, 400)
        return this.handlePoll(game, ticket)
      }

      if (request.method === "POST" && action === "leave") {
        const body = (await request.json()) as { ticket?: string }
        if (!body.ticket) return jsonResponse({ error: "ticket required" }, 400)
        return this.handleLeave(game, body.ticket)
      }

      if (request.method === "GET" && action === "health") {
        return this.handleHealth(game)
      }

      return jsonResponse({ error: "not found" }, 404)
    } catch (err) {
      const message = err instanceof Error ? err.message : "server error"
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

  private async setQueue(game: string, queue: Player[]): Promise<void> {
    const state = await this.loadState()
    state.queues[game] = queue
    await this.saveState(state)
  }

  private async getMatches(): Promise<Record<string, MatchWithRole>> {
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

  private async setMatch(ticket: string, match: MatchWithRole): Promise<void> {
    const state = await this.loadState()
    state.matches[ticket] = match
    await this.saveState(state)
  }

  private async deleteMatch(ticket: string): Promise<void> {
    const state = await this.loadState()
    delete state.matches[ticket]
    await this.saveState(state)
  }

  private async removeFromQueue(game: string, ticket: string): Promise<void> {
    const queue = (await this.getQueue(game)).filter((p) => p.ticket !== ticket)
    await this.setQueue(game, queue)
  }

  private async handleJoin(game: string, body: unknown): Promise<Response> {
    if (!ALLOWED_GAMES.has(game)) {
      return jsonResponse({ error: "unknown game" }, 400)
    }
    const req = body as MatchmakingRequest
    if (!req.peerId || typeof req.peerId !== "string") {
      return jsonResponse({ error: "peerId required" }, 400)
    }

    const queue = await this.getQueue(game)
    const ticket = generateTicket()
    const roomId = generateRoomId()

    const player: Player = {
      ticket,
      peerId: req.peerId,
      roomId,
      displayName: sanitizeDisplayName(req.displayName),
      guestId: req.guestId ?? "guest",
      joinedAt: Date.now(),
    }

    const opponent = queue.find((p) => p.peerId !== req.peerId)
    if (opponent) {
      await this.removeFromQueue(game, opponent.ticket)
      const match: Match = {
        roomId: opponent.roomId,
        host: {
          peerId: opponent.roomId,
          displayName: opponent.displayName,
          guestId: opponent.guestId,
        },
        guest: {
          peerId: player.peerId,
          displayName: player.displayName,
          guestId: player.guestId,
        },
      }
      await this.setMatch(opponent.ticket, { ...match, role: "host", game, createdAt: Date.now() })
      await this.setMatch(player.ticket, { ...match, role: "guest", game, createdAt: Date.now() })
      return jsonResponse({
        status: "matched",
        match: { ...match, role: "guest", game, createdAt: Date.now() },
      })
    }

    await this.setQueue(game, [...queue, player])
    return jsonResponse({ status: "waiting", ticket, roomId })
  }

  private async handlePoll(game: string, ticket: string): Promise<Response> {
    const matches = await this.getMatches()
    const match = matches[ticket]
    if (match) {
      return jsonResponse({ status: "matched", match })
    }

    const queue = await this.getQueue(game)
    const player = queue.find((p) => p.ticket === ticket)
    if (!player) {
      return jsonResponse({ error: "ticket not found" }, 404)
    }

    return jsonResponse({ status: "waiting", ticket, roomId: player.roomId })
  }

  private async handleLeave(game: string, ticket: string): Promise<Response> {
    await this.removeFromQueue(game, ticket)
    await this.deleteMatch(ticket)
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
      if (!/^[A-Za-z0-9]{4,16}$/.test(roomId)) {
        return jsonResponse({ error: "invalid room id" }, 400)
      }
      const id = env.GAME_ROOM.idFromName(roomId)
      const stub = env.GAME_ROOM.get(id)
      return stub.fetch(request)
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() })
    }

    const id = env.MATCHMAKING_QUEUES.idFromName("global")
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

function generateTicket(): string {
  return `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`
}

function generateRoomId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()
}

function sanitizeDisplayName(value: string | undefined | null): string {
  const safe = (value ?? "Guest").replace(/[<>]/g, "").trim().slice(0, 20)
  return safe.length >= 2 ? safe : "Guest"
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  })
}
