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

  it("rejects unknown games", async () => {
    const response = await join("unochess", "peer-9", "g9", "Alice")
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe("unknown game")
  })
})
