/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Contract tests: the SDK's injectable `socket`/`fetch` pointed at the real
 * room DO and the real matchmaking routes (the Workers-pool pattern from
 * M room.test.ts:21-33). Three cases: credential round-trip,
 * slotToken-gated matchmade rooms, and recycle-vs-leave peer reasons.
 */

import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import worker from "../../../src/index"
import type { StorageLike } from "../../src/identity"
import type { MessageDataEvent, RoomEnvelope, WebSocketLike } from "../../src/socket"
import { RoomSocket } from "../../src/socket"

let roomCounter = 0
function freshRoom(): string {
  roomCounter += 1
  return `CT${Date.now().toString(36)}${roomCounter}`.slice(0, 20)
}

let ipCounter = 100
function nextIp(): string {
  ipCounter += 1
  return `198.19.${Math.floor(ipCounter / 256)}.${ipCounter % 256}`
}

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  }
}

/** Open the client side of a real DO socket pair for `room`. */
async function openPair(room: string, game = "tictactoe"): Promise<WebSocket> {
  const id = env.GAME_ROOM.idFromName(room)
  const stub = env.GAME_ROOM.get(id)
  const resp = await stub.fetch(
    new Request(`https://test.invalid/?game=${game}`, {
      headers: { Upgrade: "websocket" },
    }),
  )
  if (resp.status !== 101) throw new Error(`expected 101, got ${resp.status}`)
  const ws = resp.webSocket
  if (!ws) throw new Error("no webSocket on response")
  ws.accept()
  return ws
}

/**
 * Bridge a real, already-accepted pair socket into WebSocketLike.
 * The pair is open before RoomSocket ever sees it, so the first "open"
 * listener fires the synthetic open on a microtask — the hello still
 * lands far inside the relay's 10 s hello deadline.
 */
class PairSocket implements WebSocketLike {
  private readonly inner: WebSocket
  private readonly handlers = new Map<string, Array<(event: MessageDataEvent) => void>>()
  private openSent = false

  constructor(inner: WebSocket) {
    this.inner = inner
    inner.addEventListener("message", (event) => {
      this.emit("message", { data: (event as MessageEvent).data })
    })
    inner.addEventListener("close", (event) => {
      this.emit("close", event as unknown as MessageDataEvent)
    })
    inner.addEventListener("error", (event) => {
      this.emit("error", event as unknown as MessageDataEvent)
    })
  }

  get readyState(): number {
    return this.inner.readyState
  }

  send(data: string): void {
    this.inner.send(data)
  }

  close(code?: number, reason?: string): void {
    this.inner.close(code ?? 1000, reason ?? "")
  }

  addEventListener(type: string, listener: (event: MessageDataEvent) => void): void {
    const list = this.handlers.get(type) ?? []
    list.push(listener)
    this.handlers.set(type, list)
    if (type === "open" && !this.openSent) {
      this.openSent = true
      queueMicrotask(() => this.emit("open", {}))
    }
  }

  private emit(type: string, event: MessageDataEvent): void {
    for (const fn of this.handlers.get(type) ?? []) fn(event)
  }
}

function waitFor(cond: () => boolean, context: string, ms = 8000): Promise<void> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      try {
        if (cond()) {
          resolve()
          return
        }
      } catch (err) {
        reject(err)
        return
      }
      if (Date.now() - started > ms) {
        reject(new Error(`timed out waiting for: ${context}`))
        return
      }
      setTimeout(poll, 25)
    }
    poll()
  })
}

interface ClientRig {
  socket: RoomSocket
  frames: RoomEnvelope[]
  storage: StorageLike & { data: Map<string, string> }
}

/** One SDK client fed by fresh real pairs on every attempt. */
function rig(
  room: string,
  guestId: string,
  opts?: { role?: "host" | "guest"; slotToken?: string; storage?: ClientRig["storage"] },
): ClientRig {
  const storage = opts?.storage ?? memoryStorage()
  const frames: RoomEnvelope[] = []
  const socket = new RoomSocket({
    displayName: `Player-${guestId.slice(-4)}`,
    game: "tictactoe",
    guestId,
    role: opts?.role,
    slotToken: opts?.slotToken,
    autoReconnect: false,
    storage,
    wsUrl: `ws://test.invalid/room/${room}`,
    socket: (_url: string) => {
      throw new Error("rig connects explicitly via pair()")
    },
  })
  socket.setMessageHandler((msg) => frames.push(msg))
  return { socket, frames, storage }
}

/** Connect a rig through exactly one fresh pair (replaces the factory). */
async function connectVia(
  rigged: ClientRig,
  pair: WebSocket,
): Promise<{ role: "host" | "guest"; opponent: unknown }> {
  const inner = rigged.socket as unknown as {
    opts: { createSocket: (_url: string) => WebSocketLike }
  }
  inner.opts.createSocket = () => new PairSocket(pair)
  return (await rigged.socket.connect()) as { role: "host" | "guest"; opponent: unknown }
}

async function join(
  peerId: string,
  guestId: string,
  displayName: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await worker.fetch(
    new Request("https://test.invalid/api/matchmaking/tictactoe/join", {
      method: "POST",
      body: JSON.stringify({ peerId, guestId, displayName }),
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": nextIp() },
    }),
    env,
  )
  const body = (await response.json()) as Record<string, unknown>
  return { status: response.status, body }
}

async function poll(ticket: string): Promise<Record<string, unknown>> {
  const response = await worker.fetch(
    new Request(`https://test.invalid/api/matchmaking/tictactoe/poll?ticket=${ticket}`),
    env,
  )
  return (await response.json()) as Record<string, unknown>
}

describe("contract: credential round-trip", () => {
  it("a refresh reclaims the same seat with the persisted token", async () => {
    const room = freshRoom()
    const storage = memoryStorage()

    const first = rig(room, "guest:ct-roundtrip-1", { storage })
    const pairA = await openPair(room)
    const sessionA = await connectVia(first, pairA)
    expect(sessionA.role).toBe("host")
    const tokenKey = `fuurma:room-token:${room}`
    const token = storage.data.get(tokenKey)
    expect(typeof token === "string" && token.length > 0).toBe(true)

    // Unclean drop (no departure signature): the slot survives for grace.
    // A refresh never calls close() — and must not, since close() owns
    // forgetting the credentials. first is abandoned with autoReconnect off.
    pairA.close()

    // A fresh instance — same guestId, persisted token — reclaims the seat.
    const second = rig(room, "guest:ct-roundtrip-1", { storage })
    let sessionB: { role: string } | null = null
    let lastError = ""
    for (let attempt = 0; attempt < 5 && !sessionB; attempt++) {
      const pair = await openPair(room)
      try {
        const session = await connectVia(second, pair)
        sessionB = session as { role: string }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
        pair.close()
        await new Promise((r) => setTimeout(r, 300))
      }
    }
    if (!sessionB) throw new Error(`reclaim failed, last error: ${lastError}`)
    expect(sessionB.role).toBe(sessionA.role)
    second.socket.close()
  })
})

describe("contract: slotToken-gated matchmade room", () => {
  it("guest with the token is welcomed; without it is refused", async () => {
    const hostJoin = await join("peer-ct-h", "guest:ct-slot-h", "Host")
    expect(hostJoin.status).toBe(200)
    expect(hostJoin.body.status).toBe("waiting")
    const roomId = hostJoin.body.roomId as string

    const guestJoin = await join("peer-ct-g", "guest:ct-slot-g", "Guest")
    expect(guestJoin.status).toBe(200)
    expect(guestJoin.body.status).toBe("matched")
    const match = guestJoin.body.match as { roomId: string; role: string }
    expect(match.roomId).toBe(roomId)
    expect(match.role).toBe("guest")
    const slotToken = guestJoin.body.slotToken as string
    expect(typeof slotToken === "string" && slotToken.length > 0).toBe(true)

    // Without the capability the allocated room refuses the hello.
    const refused = rig(roomId, "guest:ct-slot-g")
    await expect(connectVia(refused, await openPair(roomId))).rejects.toThrow(
      "join capability required",
    )
    refused.socket.close()

    // With it the same guestId is seated as guest.
    const guest = rig(roomId, "guest:ct-slot-g", { slotToken })
    const session = await connectVia(guest, await openPair(roomId))
    expect(session.role).toBe("guest")
    guest.socket.close()

    // The host's own token seats the host (role from the poll record).
    const hostPoll = await poll(hostJoin.body.ticket as string)
    expect(hostPoll.status).toBe("matched")
    const hostMatch = hostPoll.match as { role: string }
    expect(hostMatch.role).toBe("host")
    const host = rig(roomId, "guest:ct-slot-h", { slotToken: hostPoll.slotToken as string })
    const hostSession = await connectVia(host, await openPair(roomId))
    expect(hostSession.role).toBe("host")
    host.socket.close()
  })
})

describe("contract: recycle vs leave peer reason", () => {
  it("closeForReconnect reads as disconnect; close reads as closed", async () => {
    const room = freshRoom()
    const a = rig(room, "guest:ct-peer-a")
    const b = rig(room, "guest:ct-peer-b")
    await connectVia(a, await openPair(room))
    await connectVia(b, await openPair(room))
    // Drain the join chatter both sides saw.
    a.frames.length = 0
    b.frames.length = 0

    // Recycle: the peer must see a transient disconnect, not a departure.
    a.socket.closeForReconnect()
    await waitFor(
      () => b.frames.some((f) => f.type === "peer-left"),
      "peer-left after closeForReconnect",
    )
    const recycle = b.frames.find((f) => f.type === "peer-left") as { reason: string }
    expect(recycle.reason).toBe("disconnect")
    b.frames.length = 0

    // The recycled player comes back on a fresh pair with the same client.
    await connectVia(a, await openPair(room))
    b.frames.length = 0

    // Voluntary leave: the peer must see the terminal closed.
    a.socket.close()
    await waitFor(() => b.frames.some((f) => f.type === "peer-left"), "peer-left after close")
    const leave = b.frames.find((f) => f.type === "peer-left") as { reason: string }
    expect(leave.reason).toBe("closed")
    b.socket.close()
  })
})
