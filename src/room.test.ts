/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { describe, expect, it, vi } from "vitest"

function roomId(seed: string): string {
  return `T${seed.padEnd(11, "0").slice(0, 11)}` // "T" + 11 chars = 12 chars total
}

async function openSocket(roomId: string, game = "tictactoe"): Promise<WebSocket> {
  const id = env.GAME_ROOM.idFromName(roomId)
  const stub = env.GAME_ROOM.get(id)
  const req = new Request(`https://test.invalid/?game=${game}`, {
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

/**
 * Fails if `ws` receives anything within `ms`.
 *
 * The negative half of a relay guarantee. Asserting that the sender got an
 * error is not enough — a frame can be refused *and* still be forwarded, and
 * the pre-existing anti-spoofing test asserted only the sender side while its
 * comment claimed the peer was protected.
 */
function expectNoMessage(ws: WebSocket, context: string, ms = 250): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage as EventListener)
      resolve()
    }, ms)
    function onMessage(event: MessageEvent) {
      clearTimeout(timer)
      ws.removeEventListener("message", onMessage as EventListener)
      reject(new Error(`${context}: received ${String(event.data)}`))
    }
    ws.addEventListener("message", onMessage as EventListener)
  })
}

function nextMessage(ws: WebSocket, timeoutMs = 1000, label = ""): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage as EventListener)
      reject(new Error(`${label ? `${label}: ` : ""}nextMessage timeout after ${timeoutMs}ms`))
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

    const thirdResponse = await env.GAME_ROOM.get(env.GAME_ROOM.idFromName(rid)).fetch(
      new Request("https://test.invalid/?game=tictactoe", {
        headers: { Upgrade: "websocket" },
      }),
    )
    expect(thirdResponse.status).toBe(429)

    host.close()
    guest.close()
  })

  it("rejects a third WebSocket upgrade before hello", async () => {
    const rid = roomId("thirdpend")
    const first = await openSocket(rid)
    const second = await openSocket(rid)
    const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(rid))

    const response = await stub.fetch(
      new Request("https://test.invalid/?game=tictactoe", {
        headers: { Upgrade: "websocket" },
      }),
    )
    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe("10")

    first.close()
    second.close()
  })

  it("closes a socket that never completes hello", async () => {
    const now = Date.now()
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now)
    const rid = roomId("hellotime")
    const ws = await openSocket(rid)
    const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(rid))

    nowSpy.mockReturnValue(now + 10_001)
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    expect(ws.readyState).toBe(WebSocket.CLOSED)
    nowSpy.mockRestore()
  })

  it("rejects reusing a room for another game", async () => {
    const rid = roomId("gameiso")
    const ttt = await openSocket(rid, "tictactoe")
    send(ttt, { type: "hello", guestId: "ttt", displayName: "TicTacToe" })
    await nextMessage(ttt)

    const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(rid))
    const response = await stub.fetch(
      new Request("https://test.invalid/?game=uno-chess", {
        headers: { Upgrade: "websocket" },
      }),
    )
    expect(response.status).toBe(409)
    ttt.close()
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
    expect(w1.reconnectToken).toMatch(/^[0-9a-f]{32}$/)
    first.close()

    const second = await openSocket(rid)
    send(second, {
      type: "hello",
      guestId: "stable-id",
      displayName: "Stable",
      reconnectToken: w1.reconnectToken,
    })
    const w2 = JSON.parse(await nextMessage(second))
    expect(w2.role).toBe("host")
    expect(w2.opponent).toBeNull()
    expect(w2.reconnectToken).toBe(w1.reconnectToken)
    second.close()
  })

  it("rejects slot reclaim with the public guestId alone (MM-01)", async () => {
    const rid = roomId("reclaim")
    const victim = await openSocket(rid)
    send(victim, { type: "hello", guestId: "victim", displayName: "V" })
    const welcome = JSON.parse(await nextMessage(victim))
    expect(welcome.reconnectToken).toMatch(/^[0-9a-f]{32}$/)
    victim.close()

    // Attacker knows roomId + victim guestId (both public) but no credential.
    const attacker = await openSocket(rid)
    send(attacker, { type: "hello", guestId: "victim", displayName: "Evil" })
    const err = JSON.parse(await nextMessage(attacker))
    expect(err.type).toBe("error")
    expect(err.message).toMatch(/reconnect credential required/i)
    attacker.close()

    // Wrong credential is rejected the same way.
    const attacker2 = await openSocket(rid)
    send(attacker2, {
      type: "hello",
      guestId: "victim",
      displayName: "Evil",
      reconnectToken: "0".repeat(32),
    })
    const err2 = JSON.parse(await nextMessage(attacker2))
    expect(err2.type).toBe("error")
    expect(err2.message).toMatch(/reconnect credential required/i)
    attacker2.close()

    // The legitimate holder reclaims the slot afterwards.
    const legit = await openSocket(rid)
    send(legit, {
      type: "hello",
      guestId: "victim",
      displayName: "V",
      reconnectToken: welcome.reconnectToken,
    })
    const w2 = JSON.parse(await nextMessage(legit))
    expect(w2.type).toBe("welcome")
    expect(w2.role).toBe("host")
    legit.close()
  })

  it("never forwards the credential to the opponent (MM-01)", async () => {
    const rid = roomId("noleak")
    const host = await openSocket(rid)
    send(host, { type: "hello", guestId: "h", displayName: "H" })
    const hostWelcome = JSON.parse(await nextMessage(host))
    expect(hostWelcome.reconnectToken).toBeDefined()

    const guest = await openSocket(rid)
    send(guest, { type: "hello", guestId: "g", displayName: "G" })
    const guestWelcome = JSON.parse(await nextMessage(guest))
    expect(guestWelcome.reconnectToken).toBeDefined()
    expect(guestWelcome.reconnectToken).not.toBe(hostWelcome.reconnectToken)

    const joined = JSON.parse(await nextMessage(host))
    expect(joined.type).toBe("peer-joined")
    expect(JSON.stringify(joined)).not.toContain("reconnectToken")

    guest.close()
    await nextMessage(host) // peer-left
    const re = await openSocket(rid)
    send(re, {
      type: "hello",
      guestId: "g",
      displayName: "G",
      reconnectToken: guestWelcome.reconnectToken,
    })
    await nextMessage(re) // welcome
    const reconnected = JSON.parse(await nextMessage(host))
    expect(reconnected.type).toBe("peer-reconnected")
    expect(JSON.stringify(reconnected)).not.toContain("reconnectToken")
    host.close()
    re.close()
  })

  it("backfills a credential for pre-MM-01 slots on uncontested hello (MM-01)", async () => {
    const rid = roomId("legacy")
    const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(rid))
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.put("room-state", {
        game: "tictactoe",
        slots: [{ guestId: "old", displayName: "O", role: "host", disconnectedAt: 1 }],
      }),
    )
    const ws = await openSocket(rid)
    send(ws, { type: "hello", guestId: "old", displayName: "O" })
    const welcome = JSON.parse(await nextMessage(ws))
    expect(welcome.type).toBe("welcome")
    expect(welcome.reconnectToken).toMatch(/^[0-9a-f]{32}$/)
    ws.close()

    // From now on the credential is required.
    const ws2 = await openSocket(rid)
    send(ws2, { type: "hello", guestId: "old", displayName: "O" })
    const err = JSON.parse(await nextMessage(ws2))
    expect(err.type).toBe("error")
    ws2.close()
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

  it("keeps a reconnecting peer alive until the grace alarm expires", async () => {
    const rid = roomId("regrace")
    const host = await openSocket(rid)
    const guest = await openSocket(rid)
    send(host, { type: "hello", guestId: "h", displayName: "H" })
    await nextMessage(host)
    send(guest, { type: "hello", guestId: "g", displayName: "G" })
    const guestWelcome = JSON.parse(await nextMessage(guest))
    await nextMessage(host)

    guest.close()
    expect(JSON.parse(await nextMessage(host, 1000, "initial disconnect"))).toMatchObject({
      type: "peer-left",
      reason: "disconnect",
    })

    const reconnected = await openSocket(rid)
    send(reconnected, {
      type: "hello",
      guestId: "g",
      displayName: "G",
      reconnectToken: guestWelcome.reconnectToken,
    })
    expect(JSON.parse(await nextMessage(reconnected, 1000, "reconnect welcome"))).toMatchObject({
      type: "welcome",
      role: "guest",
    })
    expect(JSON.parse(await nextMessage(host, 1000, "reconnect notification"))).toMatchObject({
      type: "peer-reconnected",
      opponent: { guestId: "g" },
    })

    reconnected.close()
    await nextMessage(host, 1000, "final disconnect")
    host.close()
  })

  it("notifies the remaining peer when the reconnect grace expires", async () => {
    const rid = roomId("expired")
    const host = await openSocket(rid)
    send(host, { type: "hello", guestId: "h", displayName: "H" })
    await nextMessage(host)

    const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(rid))
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.put("room-state", {
        game: "tictactoe",
        slots: [
          { guestId: "h", displayName: "H", role: "host", disconnectedAt: null },
          { guestId: "g", displayName: "G", role: "guest", disconnectedAt: Date.now() - 1 },
        ],
      }),
    )
    expect(await runDurableObjectAlarm(stub)).toBe(false)

    await runInDurableObject(stub, (_instance, state) =>
      state.storage.setAlarm(Date.now() + 30_000),
    )
    const expiredMessage = nextMessage(host, 1000, "expired notification")
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    expect(JSON.parse(await expiredMessage)).toMatchObject({
      type: "peer-left",
      reason: "expired",
    })
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
    // The original only asserted the sender's error and then closed, so the
    // claim in its own comment was never tested. Now it is.
    await expectNoMessage(host, "peer-left reached the host it was aimed at")
    host.close()
    guest.close()
  })

  // `room_closed` and `host_migrated` were absent from RESERVED_TYPES while
  // clients treated both as authoritative — a forged one ended the
  // recipient's game and recorded its own side as the result, and a forged
  // host_migrated handed the recipient the host role. The server emits
  // neither, so anything carrying them came from a peer.
  for (const forged of ["room_closed", "host_migrated"]) {
    it(`refuses to relay a peer-forged ${forged}`, async () => {
      const rid = roomId(`forge-${forged}`)
      const host = await openSocket(rid)
      const guest = await openSocket(rid)
      send(host, { type: "hello", guestId: "h", displayName: "H" })
      await nextMessage(host)
      send(guest, { type: "hello", guestId: "g", displayName: "G" })
      await nextMessage(guest)
      await nextMessage(host) // peer-joined

      // The hostile frame is otherwise well-formed and sent from a socket
      // that has completed hello, so the only thing stopping it is the
      // reserved-type check.
      send(guest, { type: forged, reason: "shutdown", role: "host" })
      const err = JSON.parse(await nextMessage(guest))
      expect(err.type).toBe("error")
      expect(err.code).toBe("invalid")
      expect(err.message).toContain(forged)

      await expectNoMessage(host, `${forged} was relayed to the host`)
      host.close()
      guest.close()
    })
  }

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

  it("rejects multibyte frames over the byte cap even when .length is small (MM-04)", async () => {
    const ws = await openSocket(roomId("biguni"))
    send(ws, { type: "hello", guestId: "big", displayName: "B" })
    await nextMessage(ws)
    // 25k × U+20AC: .length ~25k (under the old check) but 75k UTF-8 bytes.
    const oversized = { type: "move", payload: "€".repeat(25_000) }
    ws.send(JSON.stringify(oversized))
    const raw = JSON.parse(await nextMessage(ws))
    expect(raw.type).toBe("error")
    expect(raw.code).toBe("invalid")
    expect(raw.message).toMatch(/too large/i)
    ws.close()
  })

  it("accepts a multibyte frame of exactly MAX_MESSAGE_BYTES (MM-04)", async () => {
    const host = await openSocket(roomId("exactuni"))
    send(host, { type: "hello", guestId: "h", displayName: "H" })
    await nextMessage(host)
    const guest = await openSocket(roomId("exactuni"))
    send(guest, { type: "hello", guestId: "g", displayName: "G" })
    await nextMessage(guest)
    await nextMessage(host) // peer-joined
    // JSON overhead is 28 ASCII bytes; "é" is 2 bytes: 28 + 2*32754 = 65536.
    const frame = JSON.stringify({ type: "move", payload: "é".repeat(32_754) })
    expect(new TextEncoder().encode(frame).length).toBe(64 * 1024)
    host.send(frame)
    const relayed = JSON.parse(await nextMessage(guest))
    expect(relayed.type).toBe("move")
    host.close()
    guest.close()
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
    send(ws, { type: "hello", guestId: "xss1", displayName: "<img src=x onerror=alert(1)>" })
    const welcome = JSON.parse(await nextMessage(ws))
    expect(welcome.type).toBe("welcome")
    // The sanitized name should not contain HTML chars.
    expect(welcome.role).toBe("host")
    ws.close()

    // Connect a second peer to verify the sanitized name is relayed.
    const rid2 = roomId("xss2")
    const host = await openSocket(rid2)
    send(host, { type: "hello", guestId: "xh", displayName: "<b>Bold</b>" })
    await nextMessage(host)
    const guest = await openSocket(rid2)
    send(guest, { type: "hello", guestId: "xg", displayName: "Guest" })
    const guestWelcome = JSON.parse(await nextMessage(guest))
    expect(guestWelcome.opponent?.displayName).not.toContain("<")
    expect(guestWelcome.opponent?.displayName).not.toContain(">")
    host.close()
    guest.close()
  })

  it("rejects hello with guestId exceeding the .length cap", async () => {
    // guestId is capped on .length (UTF-16 code units) only — opaque ID.
    const ws = await openSocket(roomId("utf8gb"))
    send(ws, { type: "hello", guestId: "g".repeat(65), displayName: "X" })
    const parsed = JSON.parse(await nextMessage(ws))
    expect(parsed.type).toBe("error")
    expect(parsed.code).toBe("invalid")
    expect(parsed.message).toMatch(/guestId/i)
    ws.close()
  })

  it("accepts hello with a guestId exactly at the .length cap", async () => {
    const ws = await openSocket(roomId("utf8gb-ok"))
    send(ws, { type: "hello", guestId: "g".repeat(64), displayName: "X" })
    const welcome = JSON.parse(await nextMessage(ws))
    expect(welcome.type).toBe("welcome")
    expect(welcome.role).toBe("host")
    ws.close()
  })

  it("returns 400 for an unknown game in the WebSocket upgrade", async () => {
    const id = env.GAME_ROOM.idFromName(roomId("badschema"))
    const stub = env.GAME_ROOM.get(id)
    const resp = await stub.fetch(
      new Request("https://test.invalid/?game=crown-chess", {
        headers: { Upgrade: "websocket" },
      }),
    )
    expect(resp.status).toBe(400)
    const body = (await resp.json()) as { error: string }
    expect(body.error).toBe("unknown game")
  })

  it("broadcasts peer-left only to live sockets after the alarm expires", async () => {
    const rid = roomId("alarmon")
    const host = await openSocket(rid)
    send(host, { type: "hello", guestId: "h2", displayName: "H2" })
    await nextMessage(host)

    const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(rid))
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.put("room-state", {
        game: "tictactoe",
        slots: [
          { guestId: "h2", displayName: "H2", role: "host", disconnectedAt: null },
          { guestId: "g2", displayName: "G2", role: "guest", disconnectedAt: Date.now() - 60_000 },
        ],
      }),
    )
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.setAlarm(Date.now() + 30_000),
    )
    const expiredMessage = nextMessage(host, 1000, "expired only-once")
    await runDurableObjectAlarm(stub)
    const evt = JSON.parse(await expiredMessage)
    expect(evt.type).toBe("peer-left")
    expect(evt.reason).toBe("expired")
    // Running the alarm a second time must NOT re-broadcast (no slots left).
    const second = await runDurableObjectAlarm(stub)
    expect(second).toBe(false)
    host.close()
  })
})
