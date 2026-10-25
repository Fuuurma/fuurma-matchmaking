/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, runInDurableObject } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import worker from "./index"

// Every join gets its own client address unless a test pins one: the DO keeps
// ONE per-IP join counter for the whole file, and the suite joins often enough
// from a shared "unknown" address to trip the 20-per-minute limit.
let ipCounter = 0
function nextIp(): string {
  ipCounter += 1
  return `198.18.${Math.floor(ipCounter / 256)}.${ipCounter % 256}`
}

async function join(
  game: string,
  peerId: string,
  guestId: string,
  displayName: string,
  ip = nextIp(),
) {
  const response = await worker.fetch(
    new Request(`https://test.invalid/api/matchmaking/${game}/join`, {
      method: "POST",
      body: JSON.stringify({ peerId, guestId, displayName }),
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    }),
    env,
  )
  return response
}

async function leave(game: string, ticket: string) {
  return worker.fetch(
    new Request(`https://test.invalid/api/matchmaking/${game}/leave`, {
      method: "POST",
      body: JSON.stringify({ ticket }),
      headers: { "Content-Type": "application/json" },
    }),
    env,
  )
}

async function poll(game: string, ticket: string) {
  return worker.fetch(
    new Request(`https://test.invalid/api/matchmaking/${game}/poll?ticket=${ticket}`),
    env,
  )
}

async function health(game: string) {
  return worker.fetch(new Request(`https://test.invalid/api/matchmaking/${game}/health`), env)
}

describe("MatchmakingQueues via worker fetch", () => {
  it("rejects malformed and oversized join payloads", async () => {
    const malformed = await worker.fetch(
      new Request("https://test.invalid/api/matchmaking/tictactoe/join", {
        method: "POST",
        body: "not-json",
        headers: { "Content-Type": "application/json" },
      }),
      env,
    )
    expect(malformed.status).toBe(400)

    const oversized = await join("tictactoe", "x".repeat(129), "g-bad", "Bad")
    expect(oversized.status).toBe(400)

    const oversizedGuest = await join("tictactoe", "peer-bad-guest", "g".repeat(65), "Bad")
    expect(oversizedGuest.status).toBe(400)
  })

  it("rejects declared-oversize join bodies with 413 (MM-03)", async () => {
    const response = await worker.fetch(
      new Request("https://test.invalid/api/matchmaking/tictactoe/join", {
        method: "POST",
        body: JSON.stringify({ peerId: "p", junk: "x".repeat(10 * 1024) }),
        headers: { "Content-Type": "application/json" },
      }),
      env,
    )
    expect(response.status).toBe(413)
    const body = (await response.json()) as { error: string }
    expect(body.error).toMatch(/too large/i)
  })

  it("stops chunked oversize bodies at the limit without buffering all (MM-03)", async () => {
    let pulls = 0
    const chunk = new TextEncoder().encode("y".repeat(1024))
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++
        if (pulls <= 20) controller.enqueue(chunk)
        else controller.close()
      },
    })
    const response = await worker.fetch(
      new Request("https://test.invalid/api/matchmaking/tictactoe/join", {
        method: "POST",
        body: stream,
        headers: { "Content-Type": "application/json" },
        duplex: "half",
      } as RequestInit),
      env,
    )
    expect(response.status).toBe(413)
    // 8 KiB cap / 1 KiB chunks: must stop after ~9 pulls, not all 20.
    expect(pulls).toBeLessThan(20)
    expect(pulls).toBeGreaterThan(0)
  })

  it("accepts a join body of exactly MAX_JSON_BODY_BYTES (MM-03)", async () => {
    const base = JSON.stringify({ peerId: "p-exact", junk: "" })
    const pad = 8 * 1024 - base.length
    expect(pad).toBeGreaterThan(0)
    const body = JSON.stringify({ peerId: "p-exact", junk: "x".repeat(pad) })
    expect(new TextEncoder().encode(body).length).toBe(8 * 1024)
    const response = await worker.fetch(
      new Request("https://test.invalid/api/matchmaking/tictactoe/join", {
        method: "POST",
        body,
        headers: { "Content-Type": "application/json" },
      }),
      env,
    )
    expect(response.status).toBe(200)
    await leave("tictactoe", ((await response.json()) as { ticket: string }).ticket)
  })

  it("throttles repeated joins from the same client address", async () => {
    const headers = {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "198.51.100.88",
    }
    let last: Response | null = null
    for (let i = 0; i < 21; i += 1) {
      last = await worker.fetch(
        new Request("https://test.invalid/api/matchmaking/gambit-deck/join", {
          method: "POST",
          body: JSON.stringify({
            peerId: `rate-peer-${i}`,
            guestId: `rate-guest-${i}`,
            displayName: "Rate",
          }),
          headers,
        }),
        env,
      )
    }
    expect(last?.status).toBe(429)
    expect(last?.headers.get("Retry-After")).toBeTruthy()
  })

  it("join returns waiting and then pairs two players", async () => {
    const host = await join("tictactoe", "peer-1", "g1", "Alice")
    expect(host.status).toBe(200)
    const hostBody = (await host.json()) as { status: "waiting"; ticket: string; roomId: string }
    expect(hostBody.status).toBe("waiting")
    expect(hostBody.ticket).toBeTruthy()
    expect(hostBody.roomId).toMatch(/^[A-Z0-9]{32}$/)

    const guest = await join("tictactoe", "peer-2", "g2", "Bob")
    expect(guest.status).toBe(200)
    const guestBody = (await guest.json()) as {
      status: "matched"
      match: {
        roomId: string
        role: "host" | "guest"
        host: { peerId: string; displayName: string; guestId: string }
        guest: { peerId: string; displayName: string; guestId: string }
        wsUrl: string
      }
    }
    expect(guestBody.status).toBe("matched")
    expect(guestBody.match.role).toBe("guest")
    expect(guestBody.match.roomId).toBe(hostBody.roomId)
    expect(guestBody.match.host.peerId).toBe("peer-1")
    expect(guestBody.match.host.displayName).toBe("Alice")
    expect(guestBody.match.host.guestId).toBe("g1")
    expect(guestBody.match.guest.peerId).toBe("peer-2")
    expect(guestBody.match.guest.displayName).toBe("Bob")
    expect(guestBody.match.guest.guestId).toBe("g2")
    expect(guestBody.match.host.peerId).not.toBe(guestBody.match.roomId)
    expect(guestBody.match.wsUrl).toBe(`wss://test.invalid/room/${guestBody.match.roomId}`)

    await leave("tictactoe", hostBody.ticket)
  })

  it("poll returns waiting and then matched for host", async () => {
    const host = await join("tictactoe", "peer-3", "g3", "Alice")
    const hostBody = (await host.json()) as { status: "waiting"; ticket: string; roomId: string }

    const pollWaiting = await poll("tictactoe", hostBody.ticket)
    const waitingBody = (await pollWaiting.json()) as { status: "waiting" }
    expect(waitingBody.status).toBe("waiting")

    await join("tictactoe", "peer-4", "g4", "Bob")

    const pollMatched = await poll("tictactoe", hostBody.ticket)
    const matchedBody = (await pollMatched.json()) as {
      status: "matched"
      match: { role: string; wsUrl: string }
    }
    expect(matchedBody.status).toBe("matched")
    expect(matchedBody.match.role).toBe("host")
    expect(matchedBody.match.wsUrl).toBe(`wss://test.invalid/room/${hostBody.roomId}`)

    await leave("tictactoe", hostBody.ticket)
  })

  it("does not pair the same guestId", async () => {
    const first = await join("tictactoe", "peer-5", "g5", "Alice")
    const firstBody = (await first.json()) as { status: "waiting"; ticket: string }
    expect(firstBody.status).toBe("waiting")

    // Same guestId, different peerId — should not pair with the first.
    const duplicate = await join("tictactoe", "peer-5b", "g5", "Alice2")
    const duplicateBody = (await duplicate.json()) as { status: "waiting"; ticket: string }
    expect(duplicateBody.status).toBe("waiting")

    // A different guest pairs with the first queued player.
    const other = await join("tictactoe", "peer-6", "g6", "Bob")
    const otherBody = (await other.json()) as {
      status: "matched"
      match: { host: { guestId: string }; guest: { guestId: string } }
    }
    expect(otherBody.status).toBe("matched")
    expect(otherBody.match.host.guestId).toBe("g5")
    expect(otherBody.match.guest.guestId).toBe("g6")

    // The duplicate ticket is still waiting.
    const pollDuplicate = await poll("tictactoe", duplicateBody.ticket)
    const pollDuplicateBody = (await pollDuplicate.json()) as { status: string }
    expect(pollDuplicateBody.status).toBe("waiting")

    await leave("tictactoe", firstBody.ticket)
    await leave("tictactoe", duplicateBody.ticket)
  })

  it("leave removes both sides of a match", async () => {
    const host = await join("tictactoe", "peer-7", "g7", "Alice")
    const hostBody = (await host.json()) as { status: "waiting"; ticket: string }

    const guest = await join("tictactoe", "peer-8", "g8", "Bob")
    expect(guest.status).toBe(200)
    const guestBody = (await guest.json()) as { status: "matched"; match: { role: string } }
    expect(guestBody.status).toBe("matched")

    const leaveHost = await leave("tictactoe", hostBody.ticket)
    expect(leaveHost.status).toBe(200)
    const leaveHostBody = (await leaveHost.json()) as { status: string }
    expect(leaveHostBody.status).toBe("left")

    const healthResp = await health("tictactoe")
    const healthBody = (await healthResp.json()) as { waiting: number; matches: number }
    expect(healthBody.waiting).toBe(0)
    expect(healthBody.matches).toBe(0)

    const pollHost = await poll("tictactoe", hostBody.ticket)
    expect(pollHost.status).toBe(404)
  })

  it("issues opaque 128-bit tickets unique per join (MM-02)", async () => {
    const first = await join("tictactoe", "peer-t1", "gt1", "Alice")
    const firstBody = (await first.json()) as { status: "waiting"; ticket: string }
    expect(firstBody.ticket).toMatch(/^[0-9a-f]{32}$/)

    const second = await join("tictactoe", "peer-t2", "gt2", "Bob")
    const secondBody = (await second.json()) as {
      status: "matched" | "waiting"
      ticket?: string
    }
    // Second join matched the first; rejoin after leaving to get a new ticket.
    await leave("tictactoe", firstBody.ticket)
    const third = await join("tictactoe", "peer-t3", "gt3", "Cara")
    const thirdBody = (await third.json()) as { status: "waiting"; ticket: string }
    expect(thirdBody.ticket).toMatch(/^[0-9a-f]{32}$/)
    expect(thirdBody.ticket).not.toBe(firstBody.ticket)
    expect(secondBody.status).toBe("matched")
    await leave("tictactoe", thirdBody.ticket)
  })

  it("poll and leave reject malformed tickets with 400 (MM-02)", async () => {
    for (const bad of ["bogus", "abc-12345678", "0".repeat(31), "g".repeat(32)]) {
      const pollResp = await poll("tictactoe", bad)
      expect(pollResp.status).toBe(400)
      const leaveResp = await leave("tictactoe", bad)
      expect(leaveResp.status).toBe(400)
    }
    // Well-formed but unknown tickets still 404 on poll.
    const unknown = await poll("tictactoe", "0".repeat(32))
    expect(unknown.status).toBe(404)
  })

  it("rejects unknown games", async () => {
    // The card-chess game's retired key is the one that matters here: a client
    // that still holds it must be refused, not silently queued. Keep the string.
    const response = await join("unochess", "peer-9", "g9", "Alice")
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe("unknown game")
  })

  it("returns existing ticket when same peerId re-joins", async () => {
    const first = await join("tictactoe", "peer-dup", "gd1", "Dup")
    const firstBody = (await first.json()) as { status: string; ticket: string; roomId: string }
    expect(firstBody.status).toBe("waiting")

    const second = await join("tictactoe", "peer-dup", "gd1-different", "Dup2")
    const secondBody = (await second.json()) as { status: string; ticket: string; roomId: string }
    expect(secondBody.status).toBe("waiting")
    // Same ticket returned — no duplicate queue entry.
    expect(secondBody.ticket).toBe(firstBody.ticket)
    expect(secondBody.roomId).toBe(firstBody.roomId)

    // Health should show only 1 waiting player.
    const h = await health("tictactoe")
    const hBody = (await h.json()) as { waiting: number }
    expect(hBody.waiting).toBe(1)

    await leave("tictactoe", firstBody.ticket)
  })

  it("sanitizes display names (strips HTML chars and control chars)", async () => {
    const host = await join("tictactoe", "peer-san", "gs1", "<script>alert(1)</script>")
    const hostBody = (await host.json()) as { status: string; ticket: string }
    expect(hostBody.status).toBe("waiting")

    const guest = await join("tictactoe", "peer-san2", "gs2", "Bob")
    const guestBody = (await guest.json()) as {
      status: string
      match: { host: { displayName: string }; guest: { displayName: string } }
    }
    expect(guestBody.status).toBe("matched")
    // HTML tags stripped, leaving "scriptalert(1)/script" which is >= 2 chars.
    expect(guestBody.match.host.displayName).not.toContain("<")
    expect(guestBody.match.host.displayName).not.toContain(">")
    expect(guestBody.match.guest.displayName).toBe("Bob")

    await leave("tictactoe", hostBody.ticket)
  })

  it("rejects displayName whose UTF-8 byte length exceeds 256 bytes (emoji blow-up)", async () => {
    // 🎉 is 4 UTF-8 bytes / 2 UTF-16 code units. 100 emoji = 200 .length
    // / 400 bytes — well over the 256-byte UTF-8 cap, must be rejected.
    const emoji = "🎉".repeat(100)
    expect(emoji.length).toBe(200)
    expect(new TextEncoder().encode(emoji).length).toBe(400)

    const response = await worker.fetch(
      new Request("https://test.invalid/api/matchmaking/tictactoe/join", {
        method: "POST",
        body: JSON.stringify({
          peerId: "peer-emoji",
          guestId: "g-emoji",
          displayName: emoji,
        }),
        headers: { "Content-Type": "application/json" },
      }),
      env,
    )
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string }
    expect(body.error).toMatch(/UTF-8 bytes/i)
  })

  it("accepts a displayName within both length and UTF-8 byte bounds", async () => {
    // 30 ASCII chars = 30 bytes / 30 .length — well under both caps.
    const response = await join("tictactoe", "peer-utf8-ok", "g-utf8-ok", "X".repeat(30))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { status: string; ticket: string }
    expect(body.status).toBe("waiting")
    await leave("tictactoe", body.ticket)
  })

  it("rejects a peerId exceeding the .length cap (opaque ID, not a renderable name)", async () => {
    // peerId is capped on .length (UTF-16 code units) only — it's an opaque
    // identifier from the client, never rendered to peers.
    const longPeer = "p".repeat(129)
    const response = await join("tictactoe", longPeer, "g-bytelen", "OK")
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string }
    expect(body.error).toMatch(/peerId required/i)
  })

  it("accepts a peerId exactly at the .length cap", async () => {
    const atLimit = "p".repeat(128)
    const response = await join("tictactoe", atLimit, "g-atlimit", "OK")
    expect(response.status).toBe(200)
    const body = (await response.json()) as { status: string; ticket: string }
    expect(body.status).toBe("waiting")
    await leave("tictactoe", body.ticket)
  })

  it("rejects unknown game routes with 400 and never reaches a Durable Object", async () => {
    const response = await worker.fetch(
      new Request("https://test.invalid/api/matchmaking/unknown/join", {
        method: "POST",
        body: JSON.stringify({ peerId: "p", guestId: "g" }),
        headers: { "Content-Type": "application/json" },
      }),
      env,
    )
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe("unknown game")
  })

  it("returns 404 for unknown matchmaking sub-paths", async () => {
    const response = await worker.fetch(
      new Request("https://test.invalid/api/matchmaking/tictactoe/bogus", { method: "GET" }),
      env,
    )
    expect(response.status).toBe(404)
  })

  it("returns 404 for malformed top-level paths", async () => {
    const response = await worker.fetch(new Request("https://test.invalid/nope"), env)
    expect(response.status).toBe(404)
  })

  it("returns 400 for invalid room id formats", async () => {
    for (const bad of ["", "abc", "x".repeat(65), "a.b-c"]) {
      const response = await worker.fetch(
        new Request(`https://test.invalid/room/${bad}?game=tictactoe`),
        env,
      )
      expect(response.status).toBe(400)
    }
  })

  it("accepts the full client room-id contract before WebSocket validation", async () => {
    for (const roomId of ["a1_b", "x".repeat(64)]) {
      const response = await worker.fetch(
        new Request(`https://test.invalid/room/${roomId}?game=tictactoe`),
        env,
      )
      expect(response.status).toBe(426)
    }
  })

  it("carries security headers on JSON API responses", async () => {
    const response = await health("tictactoe")
    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    )
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(response.headers.get("Strict-Transport-Security")).toContain("max-age=")
  })

  // F-new-queue-state-unbounded-2026-10-04. Before the bound, a waiting
  // ticket lived as long as it kept polling (joinedAt refreshed forever) and
  // nothing capped the per-game queue or the per-IP rate-limit map — every
  // operation serialized the whole state value, so a grown queue amplified
  // into matchmaking latency for everyone.
  it("refuses the join beyond the per-game queue cap with a retryable 503", async () => {
    // All joins share one guestId so nothing pairs and the queue fills.
    // Distinct IPs keep the per-IP join throttle out of the measurement.
    for (let i = 0; i < 100; i += 1) {
      const response = await worker.fetch(
        new Request("https://test.invalid/api/matchmaking/gambit-deck/join", {
          method: "POST",
          body: JSON.stringify({
            peerId: `cap-peer-${i}`,
            guestId: "cap-guest",
            displayName: "Cap",
          }),
          headers: {
            "Content-Type": "application/json",
            "CF-Connecting-IP": `192.0.${Math.floor(i / 256)}.${i % 256}`,
          },
        }),
        env,
      )
      expect(response.status).toBe(200)
    }

    const overflow = await worker.fetch(
      new Request("https://test.invalid/api/matchmaking/gambit-deck/join", {
        method: "POST",
        body: JSON.stringify({ peerId: "cap-peer-overflow", guestId: "cap-guest" }),
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "203.0.113.9",
        },
      }),
      env,
    )
    expect(overflow.status).toBe(503)
    expect(overflow.headers.get("Retry-After")).toBeTruthy()
    expect(((await overflow.json()) as { error: string }).error).toMatch(/queue full/i)

    // The cap entries are real live tickets — drain them so later tests on
    // this game see an empty queue.
    const stub = env.MATCHMAKING_QUEUES.get(env.MATCHMAKING_QUEUES.idFromName("gambit-deck"))
    await runInDurableObject(stub, async (_i, s) => {
      const stored = (await s.storage.get("queue-state")) as {
        queues: Record<string, Array<{ guestId: string }>>
      }
      stored.queues["gambit-deck"] = (stored.queues["gambit-deck"] ?? []).filter(
        (p) => p.guestId !== "cap-guest",
      )
      await s.storage.put("queue-state", stored)
    })
  })

  it("expires a queued ticket at its absolute age cap even while it keeps polling", async () => {
    const stub = env.MATCHMAKING_QUEUES.get(env.MATCHMAKING_QUEUES.idFromName("tictactoe"))
    const staleTicket = "a".repeat(32)
    const now = Date.now()
    await runInDurableObject(stub, async (_i, s) => {
      await s.storage.put("queue-state", {
        queues: {
          tictactoe: [
            {
              ticket: staleTicket,
              peerId: "aged-peer",
              roomId: "A".repeat(32),
              displayName: "Aged",
              guestId: "aged-guest",
              // joinedAt fresh — the ticket would be live under the old
              // poll-refreshed rule; only the absolute age bound expires it.
              joinedAt: now,
              createdAt: now - 601_000,
            },
          ],
        },
        matches: {},
      })
    })

    const response = await poll("tictactoe", staleTicket)
    expect(response.status).toBe(404)
    expect(((await response.json()) as { error: string }).error).toMatch(/ticket not found/)
  })

  it("issues a fresh ticket on re-join after the absolute age cap instead of reviving the stale one", async () => {
    const stub = env.MATCHMAKING_QUEUES.get(env.MATCHMAKING_QUEUES.idFromName("gambit-deck"))
    const staleTicket = "b".repeat(32)
    const now = Date.now()
    await runInDurableObject(stub, async (_i, s) => {
      const stored = (await s.storage.get("queue-state")) as {
        queues: Record<string, unknown[]>
        matches: Record<string, unknown>
      }
      const queue = stored.queues["gambit-deck"] ?? []
      stored.queues["gambit-deck"] = queue
      queue.push({
        ticket: staleTicket,
        peerId: "revive-peer",
        roomId: "B".repeat(32),
        displayName: "Revive",
        guestId: "revive-guest",
        joinedAt: now,
        createdAt: now - 601_000,
      })
      await s.storage.put("queue-state", stored)
    })

    const response = await join("gambit-deck", "revive-peer", "revive-guest", "Revive")
    const body = (await response.json()) as { status: string; ticket: string }
    expect(body.status).toBe("waiting")
    expect(body.ticket).not.toBe(staleTicket)
  })
})

// The matchmaking -> room handoff (pre-claim fix). A match is only disclosed
// once the room DO has acknowledged the allocation, and the DO-to-DO `fetch`
// that does it opens the queue DO's input gate, so other requests interleave
// with it. These tests park that call (or fail it) on the DO instance to force
// the interleavings deterministically.
type Slots = { host: string; guest: string }
type BindFn = (roomId: string, match: unknown, slots: Slots) => Promise<boolean>
type Answer = {
  status: string
  ticket?: string
  roomId?: string
  slotToken?: string
  match?: { role: string; roomId: string; wsUrl: string } & Record<string, unknown>
}

const queueStub = (game: string) =>
  env.MATCHMAKING_QUEUES.get(env.MATCHMAKING_QUEUES.idFromName(game))

async function overrideBind(game: string, fn: BindFn): Promise<void> {
  await runInDurableObject(queueStub(game), (instance) => {
    ;(instance as unknown as { bindRoomSlots: BindFn }).bindRoomSlots = fn
  })
}

/** A bind that stays "in flight" until the test releases it. */
function parkedBind() {
  let release!: (ok: boolean) => void
  let enter!: () => void
  const gate = new Promise<boolean>((resolve) => {
    release = resolve
  })
  const reached = new Promise<void>((resolve) => {
    enter = resolve
  })
  const fn: BindFn = async () => {
    enter()
    return gate
  }
  return { fn, reached, release }
}

/**
 * Sends a request straight to the queue DO from inside it and reads the reply
 * there. A request parked on a bind answers from the DO's own context, and a
 * response body created there cannot be read from the test's context (workerd
 * refuses cross-DO I/O). The Worker's wsUrl rewrite is skipped, which these
 * tests do not look at.
 */
function requestInDo(game: string, path: string, init?: RequestInit) {
  return runInDurableObject(queueStub(game), async (instance) => {
    const res = await instance.fetch(
      new Request(`https://test.invalid/api/matchmaking/${game}/${path}`, init),
    )
    return { status: res.status, body: (await res.json()) as Answer }
  })
}

/** Puts the real room handoff back. */
async function restoreBind(game: string): Promise<void> {
  await runInDurableObject(queueStub(game), (instance) => {
    delete (instance as unknown as { bindRoomSlots?: BindFn }).bindRoomSlots
  })
}

/** Empties a game's queue DO and drops any bind override a previous test left. */
async function resetQueue(game: string): Promise<void> {
  await restoreBind(game)
  await runInDurableObject(queueStub(game), (_i, state) => state.storage.deleteAll())
}

async function answer(response: Response): Promise<Answer> {
  return (await response.json()) as Answer
}

async function allocation(roomId: string) {
  const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(roomId))
  const stored = (await runInDurableObject(stub, (_i, state) => state.storage.get("room-state"))) as
    | { expected?: Record<string, { token: string; role: string }> }
    | undefined
  return stored?.expected
}

describe("matchmaking to room binding", () => {
  beforeEach(async () => {
    await resetQueue("tictactoe")
  })

  it("hands each player only their own slotToken and binds both to the room", async () => {
    const hostWait = await answer(await join("tictactoe", "bp-host", "bg-host", "Host"))
    const guestRes = await join("tictactoe", "bp-guest", "bg-guest", "Guest")
    const guestText = await guestRes.clone().text()
    const guest = await answer(guestRes)
    expect(guest.status).toBe("matched")
    expect(guest.slotToken).toMatch(/^[0-9a-f]{32}$/)

    const hostRes = await poll("tictactoe", hostWait.ticket as string)
    const hostText = await hostRes.clone().text()
    const host = await answer(hostRes)
    expect(host.status).toBe("matched")
    expect(host.match?.role).toBe("host")
    expect(host.slotToken).toMatch(/^[0-9a-f]{32}$/)
    expect(host.slotToken).not.toBe(guest.slotToken)

    // Neither response may carry the other player's capability, or the
    // internal bookkeeping that holds both.
    expect(guestText).not.toContain(host.slotToken as string)
    expect(hostText).not.toContain(guest.slotToken as string)
    for (const text of [guestText, hostText]) {
      expect(text).not.toContain('"slots"')
      expect(text).not.toContain("slotsBound")
    }

    // The room was told which token belongs to which guestId.
    const expected = await allocation(hostWait.roomId as string)
    expect(expected?.["bg-host"]).toMatchObject({ token: host.slotToken, role: "host" })
    expect(expected?.["bg-guest"]).toMatchObject({ token: guest.slotToken, role: "guest" })
  })

  it("fails closed while the room is unbound: nobody is told they matched", async () => {
    await overrideBind("tictactoe", async () => false)
    const hostWait = await answer(await join("tictactoe", "fc-host", "fg-host", "Host"))
    const guestRes = await join("tictactoe", "fc-guest", "fg-guest", "Guest")
    const guestText = await guestRes.clone().text()
    const guest = await answer(guestRes)
    expect(guest.status).toBe("waiting")
    expect(guest.ticket).toMatch(/^[0-9a-f]{32}$/)
    expect(guestText).not.toContain("slotToken")
    expect(guestText).not.toContain('"match"')

    // The host's side of the same match is withheld too.
    const hostPoll = await answer(await poll("tictactoe", hostWait.ticket as string))
    expect(hostPoll.status).toBe("waiting")
  })

  it("retries the bind on poll and discloses the match once the room acknowledges it", async () => {
    await overrideBind("tictactoe", async () => false)
    const hostWait = await answer(await join("tictactoe", "rt-host", "rg-host", "Host"))
    const guestWait = await answer(await join("tictactoe", "rt-guest", "rg-guest", "Guest"))
    expect(guestWait.status).toBe("waiting")
    expect(await allocation(hostWait.roomId as string)).toBeUndefined()

    // The room is reachable again: the next poll pushes the allocation.
    await restoreBind("tictactoe")
    const guest = await answer(await poll("tictactoe", guestWait.ticket as string))
    expect(guest.status).toBe("matched")
    expect(guest.match?.role).toBe("guest")
    expect(guest.match?.roomId).toBe(hostWait.roomId)
    expect(guest.slotToken).toMatch(/^[0-9a-f]{32}$/)
    const expected = await allocation(hostWait.roomId as string)
    expect(expected?.["rg-guest"]?.token).toBe(guest.slotToken)

    const host = await answer(await poll("tictactoe", hostWait.ticket as string))
    expect(host.status).toBe("matched")
    expect(host.match?.role).toBe("host")
    expect(host.slotToken).toBe(expected?.["rg-host"]?.token)
  })

  it("answers records stored before slot tokens existed as open-mode matches", async () => {
    const ticket = "d".repeat(32)
    await runInDurableObject(queueStub("tictactoe"), async (instance, state) => {
      ;(instance as unknown as { bindRoomSlots: BindFn }).bindRoomSlots = async () => {
        throw new Error("a legacy record has nothing to bind")
      }
      const player = (guestId: string) => ({ peerId: `${guestId}-peer`, displayName: "L", guestId })
      await state.storage.put("queue-state", {
        queues: {},
        matches: {
          [ticket]: {
            roomId: "L".repeat(32),
            host: player("legacy-host"),
            guest: player("legacy-guest"),
            role: "host",
            game: "tictactoe",
            createdAt: Date.now(),
          },
        },
      })
    })

    const res = await poll("tictactoe", ticket)
    const text = await res.clone().text()
    const body = await answer(res)
    expect(res.status).toBe(200)
    expect(body.status).toBe("matched")
    expect(body.match?.role).toBe("host")
    expect(body.match?.wsUrl).toBe(`wss://test.invalid/room/${"L".repeat(32)}`)
    expect(text).not.toContain("slotToken")
  })

  it("does not lose a third player who queues while a match is binding (A-01)", async () => {
    const hostWait = await answer(await join("tictactoe", "a1-host", "a1g-host", "Host"))
    const bind = parkedBind()
    await overrideBind("tictactoe", bind.fn)
    const guestPending = requestInDo("tictactoe", "join", {
      method: "POST",
      body: JSON.stringify({ peerId: "a1-guest", guestId: "a1g-guest", displayName: "Guest" }),
      headers: { "CF-Connecting-IP": nextIp() },
    })
    await bind.reached

    const third = await answer(await join("tictactoe", "a1-third", "a1g-third", "Third"))
    expect(third.status).toBe("waiting")

    bind.release(true)
    expect((await guestPending).body.status).toBe("matched")

    const thirdPoll = await poll("tictactoe", third.ticket as string)
    expect(thirdPoll.status).toBe(200)
    expect((await answer(thirdPoll)).status).toBe("waiting")
    expect(((await (await health("tictactoe")).json()) as { waiting: number }).waiting).toBe(1)
    expect((await answer(await poll("tictactoe", hostWait.ticket as string))).status).toBe(
      "matched",
    )
  })

  it("keeps a leave that lands while the match is binding (F39)", async () => {
    const hostWait = await answer(await join("tictactoe", "f39-host", "f39g-host", "Host"))
    const bind = parkedBind()
    await overrideBind("tictactoe", bind.fn)
    const guestPending = requestInDo("tictactoe", "join", {
      method: "POST",
      body: JSON.stringify({ peerId: "f39-guest", guestId: "f39g-guest", displayName: "Guest" }),
      headers: { "CF-Connecting-IP": nextIp() },
    })
    await bind.reached

    expect((await leave("tictactoe", hostWait.ticket as string)).status).toBe(200)
    bind.release(true)

    // The host cancelled: the joiner must not be told it matched a ghost.
    const guest = (await guestPending).body
    expect(guest.status).toBe("waiting")
    expect(guest.match).toBeUndefined()
    expect((await poll("tictactoe", hostWait.ticket as string)).status).toBe(404)
    expect((await poll("tictactoe", guest.ticket as string)).status).toBe(200)
    expect(((await (await health("tictactoe")).json()) as { matches: number }).matches).toBe(0)
  })

  it("does not answer a poll with a match that was cancelled mid-bind (A-01)", async () => {
    await overrideBind("tictactoe", async () => false)
    const hostWait = await answer(await join("tictactoe", "pm-host", "pmg-host", "Host"))
    const guestWait = await answer(await join("tictactoe", "pm-guest", "pmg-guest", "Guest"))
    expect(guestWait.status).toBe("waiting")

    const bind = parkedBind()
    await overrideBind("tictactoe", bind.fn)
    const pollPending = requestInDo("tictactoe", `poll?ticket=${guestWait.ticket}`)
    await bind.reached
    await leave("tictactoe", hostWait.ticket as string)
    bind.release(true)

    expect((await pollPending).status).toBe(404)
  })
})
