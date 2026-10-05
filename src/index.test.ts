/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import worker from "./index"

/**
 * The join rate limiter is keyed on the caller's IP, and every test in this
 * file shares one synthetic client unless it opts out (the dedicated
 * rate-limit test sets its own). That made the suite's pass/fail depend on how
 * many joins happened to run inside a 60s window rather than on the behaviour
 * under test — adding a case could turn unrelated tests into 429s. Key each
 * generic test's bucket on its peerId instead, which is what the limiter is
 * conceptually bounding: one client's join rate. Same-client retries in a
 * single test keep sharing a bucket, so a genuine rate-limit test still sees
 * them accumulate.
 */
function testIpFor(peerId: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < peerId.length; i++) {
    hash ^= peerId.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  // Spread over two octets inside the TEST-NET-2 block to keep collisions rare.
  return `198.51.${100 + ((hash >>> 8) % 100)}.${(hash % 254) + 1}`
}

async function join(
  game: string,
  peerId: string,
  guestId: string,
  displayName: string,
  retryTicket?: string,
) {
  const response = await worker.fetch(
    new Request(`https://test.invalid/api/matchmaking/${game}/join`, {
      method: "POST",
      body: JSON.stringify({
        peerId,
        guestId,
        displayName,
        ...(retryTicket ? { retryTicket } : {}),
      }),
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": testIpFor(peerId) },
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
    const response = await join("unochess", "peer-9", "g9", "Alice")
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe("unknown game")
  })

  it("does not hand the waiting ticket to a caller that only knows the peerId", async () => {
    const first = await join("tictactoe", "peer-dup", "gd1", "Dup")
    const firstBody = (await first.json()) as { status: string; ticket: string; roomId: string }
    expect(firstBody.status).toBe("waiting")

    // The attacker knows the peerId (it travels to the opponent in the match
    // payload) and guesses a different guestId. They must not be able to walk
    // away with the live ticket, which is the bearer credential for poll/leave.
    const stolen = await join("tictactoe", "peer-dup", "gd1-different", "Dup2")
    expect(stolen.status).toBe(409)
    const stolenBody = (await stolen.json()) as Record<string, unknown>
    expect(stolenBody.code).toBe("retry_proof_required")
    expect(JSON.stringify(stolenBody)).not.toContain(firstBody.ticket)
    expect(JSON.stringify(stolenBody)).not.toContain(firstBody.roomId)

    // A wrong-but-plausible ticket is refused the same way, so the refusal is
    // about proof and not about the field being absent.
    const wrongProof = await join("tictactoe", "peer-dup", "gd1", "Dup", "0".repeat(32))
    expect(wrongProof.status).toBe(409)

    // The refused attempts must not have created a second queue entry, and
    // must not have pinned the victim's entry open.
    const h = await health("tictactoe")
    const hBody = (await h.json()) as { waiting: number }
    expect(hBody.waiting).toBe(1)

    await leave("tictactoe", firstBody.ticket)
  })

  it("returns the existing ticket when a genuine retry re-presents it", async () => {
    const first = await join("tictactoe", "peer-retry", "gr1", "Retry")
    const firstBody = (await first.json()) as { status: string; ticket: string; roomId: string }
    expect(firstBody.status).toBe("waiting")

    // The owner lost the join response but still holds the ticket. This is the
    // idempotent retry the one-entry-per-peerId guard exists for.
    const retry = await join("tictactoe", "peer-retry", "gr1", "Retry", firstBody.ticket)
    expect(retry.status).toBe(200)
    const retryBody = (await retry.json()) as { status: string; ticket: string; roomId: string }
    expect(retryBody.status).toBe("waiting")
    expect(retryBody.ticket).toBe(firstBody.ticket)
    expect(retryBody.roomId).toBe(firstBody.roomId)

    // Still one entry, and the proven retry refreshed its clock.
    const h = await health("tictactoe")
    const hBody = (await h.json()) as { waiting: number }
    expect(hBody.waiting).toBe(1)

    // The recovered ticket still works for polling, so the retry is not just
    // an echo — the player can carry on waiting for a match.
    const polled = await poll("tictactoe", retryBody.ticket)
    expect(polled.status).toBe(200)

    await leave("tictactoe", firstBody.ticket)
  })

  it("rejects an oversized retryTicket before it reaches the credential check", async () => {
    const first = await join("tictactoe", "peer-bounds", "gb1", "Bounds")
    const firstBody = (await first.json()) as { status: string; ticket: string }
    expect(firstBody.status).toBe("waiting")

    const tooLong = await join("tictactoe", "peer-bounds", "gb1", "Bounds", "a".repeat(65))
    expect(tooLong.status).toBe(400)

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
