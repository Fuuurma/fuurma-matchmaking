/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"

function roomId(seed: string): string {
  return `T${seed.padEnd(11, "0").slice(0, 11)}` // "T" + 11 chars = 12 chars total
}

async function openSocket(roomId: string): Promise<WebSocket> {
  const id = env.GAME_ROOM.idFromName(roomId)
  const stub = env.GAME_ROOM.get(id)
  const req = new Request(`https://test.invalid/?game=tictactoe`, {
    headers: { Upgrade: "websocket" },
  })
  const resp = await stub.fetch(req)
  if (resp.status !== 101) throw new Error(`expected 101, got ${resp.status}`)
  const ws = resp.webSocket
  if (!ws) throw new Error("no webSocket on response")
  ws.accept()
  return ws
}

function send(ws: WebSocket, payload: unknown): void {
  ws.send(JSON.stringify(payload))
}

function nextMessage(ws: WebSocket, timeoutMs = 1000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage as EventListener)
      reject(new Error(`nextMessage timeout after ${timeoutMs}ms`))
    }, timeoutMs)
    function onMessage(event: MessageEvent) {
      clearTimeout(timer)
      ws.removeEventListener("message", onMessage as EventListener)
      resolve(String(event.data))
    }
    ws.addEventListener("message", onMessage as EventListener)
  })
}

describe("GameRoomDO", () => {
  it("rejects non-WebSocket requests with 426", async () => {
    const id = env.GAME_ROOM.idFromName(roomId("nonws"))
    const stub = env.GAME_ROOM.get(id)
    const resp = await stub.fetch("https://test.invalid/", { method: "GET" })
    expect(resp.status).toBe(426)
  })

  it("greets first connection as host with no opponent", async () => {
    const ws = await openSocket(roomId("first"))
    send(ws, { type: "hello", guestId: "g-1", displayName: "Alice" })
    const welcome = JSON.parse(await nextMessage(ws))
    expect(welcome.type).toBe("welcome")
    expect(welcome.role).toBe("host")
    expect(welcome.opponent).toBeNull()
    ws.close()
  })

  it("rejects hello with missing guestId", async () => {
    const ws = await openSocket(roomId("nohello"))
    send(ws, { type: "hello" })
    const parsed = JSON.parse(await nextMessage(ws))
    expect(parsed.type).toBe("error")
    expect(parsed.code).toBe("invalid")
    ws.close()
  })

  it("relays messages between two connections and notifies peer join", async () => {
    const rid = roomId("twocon")
    const host = await openSocket(rid)
    const guest = await openSocket(rid)

    send(host, { type: "hello", guestId: "h", displayName: "Host" })
    const hostWelcome = JSON.parse(await nextMessage(host))
    expect(hostWelcome.type).toBe("welcome")
    expect(hostWelcome.role).toBe("host")

    send(guest, { type: "hello", guestId: "g", displayName: "Guest" })

    const guestWelcome = JSON.parse(await nextMessage(guest))
    expect(guestWelcome.type).toBe("welcome")
    expect(guestWelcome.role).toBe("guest")
    expect(guestWelcome.opponent?.guestId).toBe("h")

    const hostJoin = JSON.parse(await nextMessage(host))
    expect(hostJoin.type).toBe("peer-joined")
    expect(hostJoin.opponent?.guestId).toBe("g")

    send(host, { type: "move", index: 4 })
    const relayed = JSON.parse(await nextMessage(guest))
    expect(relayed.type).toBe("move")
    expect(relayed.index).toBe(4)

    host.close()
    guest.close()
  })

  it("rejects a third connection when two are already active", async () => {
    const rid = roomId("thirdno")
    const host = await openSocket(rid)
    const guest = await openSocket(rid)
    send(host, { type: "hello", guestId: "h", displayName: "Host" })
    await nextMessage(host)
    send(guest, { type: "hello", guestId: "g", displayName: "Guest" })
    await nextMessage(guest)
    await nextMessage(host) // peer-joined

    const third = await openSocket(rid)
    send(third, { type: "hello", guestId: "g3", displayName: "Third" })
    const err = JSON.parse(await nextMessage(third))
    expect(err.type).toBe("error")
    expect(err.code).toBe("unknown")

    host.close()
    guest.close()
    third.close()
  })

  it("responds to ping with pong", async () => {
    const ws = await openSocket(roomId("pingpong"))
    send(ws, { type: "hello", guestId: "p1", displayName: "P" })
    await nextMessage(ws)
    send(ws, { type: "ping" })
    const raw = JSON.parse(await nextMessage(ws))
    expect(raw.type).toBe("pong")
    ws.close()
  })

  it("responds with error on malformed JSON frame", async () => {
    const ws = await openSocket(roomId("badjson"))
    ws.send("not-json")
    const raw = JSON.parse(await nextMessage(ws))
    expect(raw.type).toBe("error")
    expect(raw.code).toBe("invalid")
    ws.close()
  })

  it("reuses the same role on reconnect with same guestId", async () => {
    const rid = roomId("reconne")
    const first = await openSocket(rid)
    send(first, { type: "hello", guestId: "stable-id", displayName: "Stable" })
    const w1 = JSON.parse(await nextMessage(first))
    expect(w1.role).toBe("host")
    first.close()

    const second = await openSocket(rid)
    send(second, { type: "hello", guestId: "stable-id", displayName: "Stable" })
    const w2 = JSON.parse(await nextMessage(second))
    expect(w2.role).toBe("host")
    expect(w2.opponent).toBeNull()
    second.close()
  })

  it("rejects duplicate guestId while a live socket exists", async () => {
    const rid = roomId("dupconn")
    const a = await openSocket(rid)
    send(a, { type: "hello", guestId: "stable-id", displayName: "S" })
    await nextMessage(a)

    const b = await openSocket(rid)
    send(b, { type: "hello", guestId: "stable-id", displayName: "S" })
    const err = JSON.parse(await nextMessage(b))
    expect(err.code).toBe("unknown")
    expect(err.message).toMatch(/already connected/i)
    a.close()
    b.close()
  })

  it("broadcasts peer-left on disconnect", async () => {
    const rid = roomId("peerleav")
    const host = await openSocket(rid)
    const guest = await openSocket(rid)
    send(host, { type: "hello", guestId: "h", displayName: "H" })
    await nextMessage(host)
    send(guest, { type: "hello", guestId: "g", displayName: "G" })
    await nextMessage(guest)
    await nextMessage(host) // peer-joined

    guest.close()
    const evt = JSON.parse(await nextMessage(host))
    expect(evt.type).toBe("peer-left")
    host.close()
  })

  it("rejects reserved server message types from clients (anti-spoofing)", async () => {
    const rid = roomId("spoof")
    const host = await openSocket(rid)
    const guest = await openSocket(rid)
    send(host, { type: "hello", guestId: "h", displayName: "H" })
    await nextMessage(host)
    send(guest, { type: "hello", guestId: "g", displayName: "G" })
    await nextMessage(guest)
    await nextMessage(host) // peer-joined

    // A malicious guest tries to spoof a peer-left to the host.
    send(guest, { type: "peer-left", reason: "disconnect" })
    const err = JSON.parse(await nextMessage(guest))
    expect(err.type).toBe("error")
    expect(err.code).toBe("invalid")
    // Host should NOT receive the spoofed peer-left.
    host.close()
    guest.close()
  })

  it("rejects oversized WebSocket messages", async () => {
    const ws = await openSocket(roomId("bigmsg"))
    send(ws, { type: "hello", guestId: "big", displayName: "B" })
    await nextMessage(ws)
    // Send a message exceeding the 64 KiB cap.
    const oversized = { type: "move", payload: "x".repeat(70_000) }
    ws.send(JSON.stringify(oversized))
    const raw = JSON.parse(await nextMessage(ws))
    expect(raw.type).toBe("error")
    expect(raw.code).toBe("invalid")
    expect(raw.message).toMatch(/too large/i)
    ws.close()
  })

  it("rejects relay from sockets that have not sent hello", async () => {
    const ws = await openSocket(roomId("nohello2"))
    // Send a game message before hello — should be rejected.
    send(ws, { type: "move", index: 0 })
    const raw = JSON.parse(await nextMessage(ws))
    expect(raw.type).toBe("error")
    expect(raw.code).toBe("invalid")
    expect(raw.message).toMatch(/hello first/i)
    ws.close()
  })

  it("strips HTML chars from displayName in hello", async () => {
    const ws = await openSocket(roomId("xss"))
    send(ws, { type: "hello", guestId: "xss1", displayName: '<img src=x onerror=alert(1)>' })
    const welcome = JSON.parse(await nextMessage(ws))
    expect(welcome.type).toBe("welcome")
    // The sanitized name should not contain HTML chars.
    expect(welcome.role).toBe("host")
    ws.close()

    // Connect a second peer to verify the sanitized name is relayed.
    const rid2 = roomId("xss2")
    const host = await openSocket(rid2)
    send(host, { type: "hello", guestId: "xh", displayName: '<b>Bold</b>' })
    await nextMessage(host)
    const guest = await openSocket(rid2)
    send(guest, { type: "hello", guestId: "xg", displayName: "Guest" })
    const guestWelcome = JSON.parse(await nextMessage(guest))
    expect(guestWelcome.opponent?.displayName).not.toContain("<")
    expect(guestWelcome.opponent?.displayName).not.toContain(">")
    host.close()
    guest.close()
  })
})
