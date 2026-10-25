/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, runInDurableObject } from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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

/** Puts the real room handoff back (and drops any other replaced room call). */
async function restoreBind(game: string): Promise<void> {
  await runInDurableObject(queueStub(game), (instance) => {
    // Own properties shadow the prototype methods the tests replace.
    const overridden = instance as unknown as Record<string, unknown>
    for (const name of ["bindRoomSlots", "postToRoom", "loadState"]) delete overridden[name]
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

// Each test starts from empty queues; the DOs persist across tests in a file.
beforeEach(async () => {
  await resetQueue("tictactoe")
  await resetQueue("gambit-deck")
})

afterEach(() => {
  vi.restoreAllMocks()
})

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

  it("never pairs a guestId with itself: a repeat join supersedes the old entry", async () => {
    const first = await join("tictactoe", "peer-5", "g5", "Alice")
    const firstBody = (await first.json()) as { status: "waiting"; ticket: string }
    expect(firstBody.status).toBe("waiting")

    // Same guestId, different peerId: still one player, so one queue entry.
    const duplicate = await join("tictactoe", "peer-5b", "g5", "Alice2")
    const duplicateBody = (await duplicate.json()) as { status: "waiting"; ticket: string }
    expect(duplicateBody.status).toBe("waiting")
    expect(duplicateBody.ticket).not.toBe(firstBody.ticket)
    expect((await poll("tictactoe", firstBody.ticket)).status).toBe(404)

    // A different guest pairs with the surviving entry.
    const other = await join("tictactoe", "peer-6", "g6", "Bob")
    const otherBody = (await other.json()) as {
      status: "matched"
      match: { host: { guestId: string; peerId: string }; guest: { guestId: string } }
    }
    expect(otherBody.status).toBe("matched")
    expect(otherBody.match.host.guestId).toBe("g5")
    expect(otherBody.match.host.peerId).toBe("peer-5b")
    expect(otherBody.match.guest.guestId).toBe("g6")

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

  it("supersedes the old entry when the same player re-joins (refresh lost the ticket)", async () => {
    const first = await join("tictactoe", "peer-dup", "gd1", "Dup")
    const firstBody = (await first.json()) as { status: string; ticket: string; roomId: string }
    expect(firstBody.status).toBe("waiting")

    const second = await join("tictactoe", "peer-dup", "gd1", "Dup")
    const secondBody = (await second.json()) as { status: string; ticket: string; roomId: string }
    expect(secondBody.status).toBe("waiting")
    expect(secondBody.ticket).toMatch(/^[0-9a-f]{32}$/)
    expect(secondBody.ticket).not.toBe(firstBody.ticket)
    expect(secondBody.roomId).not.toBe(firstBody.roomId)

    expect((await poll("tictactoe", firstBody.ticket)).status).toBe(404)
    const live = (await (await poll("tictactoe", secondBody.ticket)).json()) as { status: string }
    expect(live.status).toBe("waiting")
    const h = (await (await health("tictactoe")).json()) as { waiting: number }
    expect(h.waiting).toBe(1)

    await leave("tictactoe", secondBody.ticket)
  })

  it("discloses nothing to a stranger who re-joins with a known peerId or guestId (A-02)", async () => {
    // peerId and guestId reach every opponent in the match payload, so neither
    // may act as a bearer credential for the victim's live ticket.
    for (const known of ["peerId", "guestId"] as const) {
      await resetQueue("tictactoe")
      const victim = await join("tictactoe", "peer-victim", "g-victim", "Victim")
      const victimBody = (await victim.json()) as { ticket: string; roomId: string }

      const attacker =
        known === "peerId"
          ? await join("tictactoe", "peer-victim", "g-attacker", "Attacker")
          : await join("tictactoe", "peer-attacker", "g-victim", "Attacker")
      const text = await attacker.text()
      expect(JSON.parse(text).status).toBe("waiting")
      expect(text).not.toContain(victimBody.ticket)
      expect(text).not.toContain(victimBody.roomId)
      // The victim's old ticket is superseded, not handed to anybody.
      expect((await poll("tictactoe", victimBody.ticket)).status).toBe(404)
    }
  })

  it("keeps one queue entry per guestId however many peerIds it presents (A-03)", async () => {
    for (let i = 0; i < 30; i += 1) {
      const res = await join("tictactoe", `flood-peer-${i}`, "flood-guest", "Flood")
      expect(res.status).toBe(200)
    }
    const h = (await (await health("tictactoe")).json()) as { waiting: number }
    expect(h.waiting).toBe(1)
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
    // One player can no longer fill the queue (one entry per guestId, A-03), so
    // the 100-entry backstop is reached by seeding live entries directly.
    const now = Date.now()
    await runInDurableObject(queueStub("gambit-deck"), (_i, state) =>
      state.storage.put("queue-state", {
        queues: {
          "gambit-deck": Array.from({ length: 100 }, (_, i) => ({
            ticket: i.toString(16).padStart(32, "0"),
            peerId: `cap-peer-${i}`,
            roomId: `CAP${i}`.padEnd(32, "0"),
            displayName: "Cap",
            guestId: `cap-guest-${i}`,
            joinedAt: now,
            createdAt: now,
          })),
        },
        matches: {},
      }),
    )

    const overflow = await join("gambit-deck", "cap-peer-overflow", "cap-guest-overflow", "Cap")
    expect(overflow.status).toBe(503)
    expect(overflow.headers.get("Retry-After")).toBeTruthy()
    expect(((await overflow.json()) as { error: string }).error).toMatch(/queue full/i)

    // Leave the game empty for the tests after this one.
    await resetQueue("gambit-deck")
  })

  it("refuses a fourth live entry from one address but leaves other addresses alone (A-03)", async () => {
    // Entries from one address cannot pile up organically (a second joiner pairs
    // with the first), so the three live entries are seeded.
    const now = Date.now()
    const seeded = ["a", "b", "c"].map((id, i) => ({
      ticket: String(i + 1).repeat(32),
      peerId: `ip-peer-${id}`,
      roomId: id.toUpperCase().repeat(32),
      displayName: "Ip",
      guestId: `ip-guest-${id}`,
      joinedAt: now,
      createdAt: now,
      ip: "203.0.113.7",
    }))
    await runInDurableObject(queueStub("tictactoe"), (_i, state) =>
      state.storage.put("queue-state", { queues: { tictactoe: seeded }, matches: {} }),
    )

    const refused = await join("tictactoe", "ip-peer-new", "ip-guest-new", "New", "203.0.113.7")
    expect(refused.status).toBe(429)
    expect(refused.headers.get("Retry-After")).toBeTruthy()
    expect(((await refused.json()) as { error: string }).error).toMatch(/active searches/i)

    const stranger = await join(
      "tictactoe",
      "ip-peer-other",
      "ip-guest-other",
      "Other",
      "203.0.113.8",
    )
    expect(stranger.status).toBe(200)
    expect((await answer(stranger)).status).toBe("matched")
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
    await runInDurableObject(stub, (_i, s) =>
      s.storage.put("queue-state", {
        queues: {
          "gambit-deck": [
            {
              ticket: staleTicket,
              peerId: "revive-peer",
              roomId: "B".repeat(32),
              displayName: "Revive",
              guestId: "revive-guest",
              joinedAt: now,
              createdAt: now - 601_000,
            },
          ],
        },
        matches: {},
      }),
    )

    const response = await join("gambit-deck", "revive-peer", "revive-guest", "Revive")
    const body = (await response.json()) as { status: string; ticket: string }
    expect(body.status).toBe("waiting")
    expect(body.ticket).not.toBe(staleTicket)
  })
})

describe("matchmaking to room binding", () => {
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

type Health = { waiting: number; matches: number; players: number }
const healthOf = async (game: string) => (await (await health(game)).json()) as Health

describe("match records and health", () => {
  it("reports one match as one match and two players, not two matches (A-06)", async () => {
    await join("tictactoe", "hm-host", "hmg-host", "Host")
    await join("tictactoe", "hm-guest", "hmg-guest", "Guest")
    expect(await healthOf("tictactoe")).toMatchObject({ waiting: 0, matches: 1, players: 2 })

    await join("tictactoe", "hm-wait", "hmg-wait", "Wait")
    expect(await healthOf("tictactoe")).toMatchObject({ waiting: 1, matches: 1, players: 3 })
  })

  it("drops a match record shortly after its ticket collected matched (A-07)", async () => {
    const start = Date.now()
    const hostWait = await answer(await join("tictactoe", "gc-host", "gcg-host", "Host"))
    await join("tictactoe", "gc-guest", "gcg-guest", "Guest")
    const nowSpy = vi.spyOn(Date, "now")

    nowSpy.mockReturnValue(start + 1_000)
    expect((await answer(await poll("tictactoe", hostWait.ticket as string))).status).toBe(
      "matched",
    )
    // A duplicate poll (a retried request) still gets the same answer...
    nowSpy.mockReturnValue(start + 5_000)
    expect((await answer(await poll("tictactoe", hostWait.ticket as string))).status).toBe(
      "matched",
    )
    // ...but the tombstone is short, long before the 90 s match window ends.
    nowSpy.mockReturnValue(start + 30_000)
    expect((await poll("tictactoe", hostWait.ticket as string)).status).toBe(404)
    expect((await healthOf("tictactoe")).matches).toBe(0)
  })

  it("expires a match nobody collected after 90 seconds (A-07)", async () => {
    const start = Date.now()
    await join("tictactoe", "ex-host", "exg-host", "Host")
    await join("tictactoe", "ex-guest", "exg-guest", "Guest")
    const nowSpy = vi.spyOn(Date, "now")

    nowSpy.mockReturnValue(start + 80_000)
    expect((await healthOf("tictactoe")).matches).toBe(1)
    nowSpy.mockReturnValue(start + 91_000)
    expect((await healthOf("tictactoe")).matches).toBe(0)
  })

  it("caps stored match records, evicting the oldest first (A-07)", async () => {
    const now = Date.now()
    const record = (i: number) => ({
      roomId: `ROOM${i}`.padEnd(32, "0"),
      role: "host",
      game: "tictactoe",
      createdAt: now - 10_000 + i,
      host: { peerId: `cp-${i}`, displayName: "C", guestId: `cg-${i}` },
      guest: { peerId: `cq-${i}`, displayName: "C", guestId: `ch-${i}` },
    })
    const matches = Object.fromEntries(
      Array.from({ length: 400 }, (_, i) => [i.toString(16).padStart(32, "0"), record(i)]),
    )
    await runInDurableObject(queueStub("tictactoe"), (_i, state) =>
      state.storage.put("queue-state", { queues: {}, matches }),
    )

    const hostWait = await answer(await join("tictactoe", "cap-host", "capg-host", "Host"))
    await join("tictactoe", "cap-guest", "capg-guest", "Guest")

    expect((await healthOf("tictactoe")).matches).toBeLessThanOrEqual(400)
    expect((await poll("tictactoe", "0".repeat(32))).status).toBe(404) // oldest evicted
    expect((await poll("tictactoe", hostWait.ticket as string)).status).toBe(200) // newest kept
  })

  it("keeps join counters in memory, not in the persisted queue state (A-07)", async () => {
    // A stored blob from an earlier build still carries the counters.
    await runInDurableObject(queueStub("tictactoe"), (_i, state) =>
      state.storage.put("queue-state", {
        queues: {},
        matches: {},
        rateLimits: { "198.51.100.1": { count: 1, windowStartedAt: Date.now() } },
      }),
    )
    expect((await join("tictactoe", "rl-peer", "rlg-peer", "Rl")).status).toBe(200)
    const stored = await runInDurableObject(queueStub("tictactoe"), (_i, state) =>
      state.storage.get("queue-state"),
    )
    expect(stored).not.toHaveProperty("rateLimits")

    // Counting still works without it: the 21st join from one address is refused.
    let last: Response | undefined
    for (let i = 0; i < 21; i += 1) {
      last = await join("gambit-deck", `rl2-peer-${i}`, `rl2-guest-${i}`, "Rl", "198.51.100.99")
    }
    expect(last?.status).toBe(429)
  })
})

describe("pairing freshness", () => {
  it("skips a queued player who stopped polling and pairs with one who is polling (A-05)", async () => {
    const start = Date.now()
    const nowSpy = vi.spyOn(Date, "now")
    nowSpy.mockReturnValue(start)
    const ghost = await answer(await join("tictactoe", "fr-ghost", "frg-ghost", "Ghost"))

    // The ghost closed its tab; 12 s later it is still inside the 30 s TTL but
    // has not polled for longer than a live client ever goes silent.
    nowSpy.mockReturnValue(start + 12_000)
    const second = await answer(await join("tictactoe", "fr-second", "frg-second", "Second"))
    expect(second.status).toBe("waiting")

    // A third player pairs with the one who just joined, not with the ghost.
    nowSpy.mockReturnValue(start + 13_000)
    const third = await answer(await join("tictactoe", "fr-third", "frg-third", "Third"))
    expect(third.status).toBe("matched")
    expect(third.match?.role).toBe("guest")
    expect((third.match as unknown as { host: { guestId: string } }).host.guestId).toBe(
      "frg-second",
    )

    // The ghost was only skipped, not removed: if it polls again it is seen.
    nowSpy.mockReturnValue(start + 14_000)
    expect((await answer(await poll("tictactoe", ghost.ticket as string))).status).toBe("waiting")
    nowSpy.mockReturnValue(start + 15_000)
    const fourth = await answer(await join("tictactoe", "fr-fourth", "frg-fourth", "Fourth"))
    expect(fourth.status).toBe("matched")
    expect((fourth.match as unknown as { host: { guestId: string } }).host.guestId).toBe(
      "frg-ghost",
    )
  })

  it("keeps pairing with a player whose polls keep arriving", async () => {
    const start = Date.now()
    const nowSpy = vi.spyOn(Date, "now")
    nowSpy.mockReturnValue(start)
    const waiting = await answer(await join("tictactoe", "fp-wait", "fpg-wait", "Wait"))
    for (const at of [4_000, 8_000, 12_000]) {
      nowSpy.mockReturnValue(start + at)
      expect((await answer(await poll("tictactoe", waiting.ticket as string))).status).toBe(
        "waiting",
      )
    }
    nowSpy.mockReturnValue(start + 13_000)
    const joiner = await answer(await join("tictactoe", "fp-join", "fpg-join", "Join"))
    expect(joiner.status).toBe("matched")
  })

  it("judges an entry with no recorded poll (after a DO restart) by its joinedAt", async () => {
    const now = Date.now()
    const entry = (id: string, joinedAt: number) => ({
      ticket: id.repeat(32),
      peerId: `rs-peer-${id}`,
      roomId: id.toUpperCase().repeat(32),
      displayName: "Rs",
      guestId: `rs-guest-${id}`,
      joinedAt,
      createdAt: joinedAt,
    })
    await runInDurableObject(queueStub("tictactoe"), (_i, state) =>
      state.storage.put("queue-state", {
        queues: { tictactoe: [entry("a", now - 12_000), entry("b", now - 2_000)] },
        matches: {},
      }),
    )

    const joiner = await answer(await join("tictactoe", "rs-join", "rs-guest-join", "Join"))
    expect(joiner.status).toBe("matched")
    expect((joiner.match as unknown as { host: { guestId: string } }).host.guestId).toBe(
      "rs-guest-b",
    )
  })
})

describe("leaving a matched ticket releases the room (A-13)", () => {
  async function openRoomSocket(roomId: string): Promise<WebSocket> {
    const room = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(roomId))
    const res = await room.fetch(
      new Request("https://test.invalid/?game=tictactoe", { headers: { Upgrade: "websocket" } }),
    )
    const ws = res.webSocket
    if (!ws) throw new Error(`no websocket, status ${res.status}`)
    ws.accept()
    return ws
  }

  function nextFrame(ws: WebSocket, label: string): Promise<{ type: string; reason?: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label}: no frame within 1 s`)), 1000)
      ws.addEventListener(
        "message",
        (event) => {
          clearTimeout(timer)
          resolve(JSON.parse(String(event.data)))
        },
        { once: true },
      )
    })
  }

  it("tells the seated opponent the room is closed and retires the allocation", async () => {
    const host = await answer(await join("tictactoe", "rl-host", "rlg-host", "Host"))
    const guest = await answer(await join("tictactoe", "rl-guest", "rlg-guest", "Guest"))
    expect(guest.status).toBe("matched")

    const ws = await openRoomSocket(host.roomId as string)
    ws.send(
      JSON.stringify({
        type: "hello",
        guestId: "rlg-guest",
        displayName: "G",
        slotToken: guest.slotToken,
      }),
    )
    expect((await nextFrame(ws, "welcome")).type).toBe("welcome")

    // The host cancels before ever collecting the match.
    const released = nextFrame(ws, "peer-left")
    expect((await leave("tictactoe", host.ticket as string)).status).toBe(200)
    expect(await released).toMatchObject({ type: "peer-left", reason: "closed" })
    expect(await allocation(host.roomId as string)).toBeUndefined()
    ws.close()
  })

  it("still answers the leave when the room cannot be reached", async () => {
    const host = await answer(await join("tictactoe", "rf-host", "rfg-host", "Host"))
    await join("tictactoe", "rf-guest", "rfg-guest", "Guest")
    await runInDurableObject(queueStub("tictactoe"), (instance) => {
      ;(instance as unknown as { postToRoom: () => never }).postToRoom = () => {
        throw new Error("room unreachable")
      }
    })
    const res = await leave("tictactoe", host.ticket as string)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { status: string }).status).toBe("left")
  })
})

describe("error boundary (A-11)", () => {
  // An env whose Durable Object stubs throw on fetch, as when a DO is overloaded
  // or resets mid-request.
  const brokenNamespace = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: () => {
        throw new Error("Durable Object reset because its code was updated")
      },
    }),
  }
  const brokenEnv = {
    ...env,
    MATCHMAKING_QUEUES: brokenNamespace,
    GAME_ROOM: brokenNamespace,
  } as unknown as typeof env

  it("answers a JSON 503 with Retry-After when the queue DO throws, and logs the cause", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    const res = await worker.fetch(
      new Request("https://test.invalid/api/matchmaking/tictactoe/health"),
      brokenEnv,
    )
    expect(res.status).toBe(503)
    expect(res.headers.get("Retry-After")).toBeTruthy()
    expect(res.headers.get("Content-Type")).toContain("application/json")
    expect(await res.json()).toEqual({ error: "temporarily unavailable" })
    expect(logged.mock.calls.flat().join(" ")).toContain("Durable Object reset")
  })

  it("answers a JSON 503 when the room DO throws on an upgrade", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const res = await worker.fetch(
      new Request("https://test.invalid/room/ABCD1234?game=tictactoe", {
        headers: { Upgrade: "websocket" },
      }),
      brokenEnv,
    )
    expect(res.status).toBe(503)
    expect(res.headers.get("Retry-After")).toBeTruthy()
    expect(await res.json()).toEqual({ error: "temporarily unavailable" })
  })

  it("never echoes an internal error message from inside the queue DO", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    await runInDurableObject(queueStub("tictactoe"), (instance) => {
      ;(instance as unknown as { loadState: () => never }).loadState = () => {
        throw new Error("SQLITE_FULL: secret storage detail")
      }
    })
    const res = await health("tictactoe")
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).not.toContain("SQLITE")
    expect(text).not.toContain("secret")
    expect(JSON.parse(text)).toEqual({ error: "server error" })
  })
})
