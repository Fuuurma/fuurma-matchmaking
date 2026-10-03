/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import worker from "./index"

async function join(game: string, peerId: string, guestId: string, displayName: string) {
  const response = await worker.fetch(
    new Request(`https://test.invalid/api/matchmaking/${game}/join`, {
      method: "POST",
      body: JSON.stringify({ peerId, guestId, displayName }),
      headers: { "Content-Type": "application/json" },
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

  it("throttles repeated joins from the same client address", async () => {
    const headers = {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "198.51.100.88",
    }
    let last: Response | null = null
    for (let i = 0; i < 21; i += 1) {
      last = await worker.fetch(
        new Request("https://test.invalid/api/matchmaking/uno-chess/join", {
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
    expect(hostBody.roomId).toMatch(/^[A-Z0-9]{8}$/)

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
})
