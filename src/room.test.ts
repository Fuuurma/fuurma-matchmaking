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

type StoredSlot = { guestId: string; disconnectedAt: number | null }

/** Reads the persisted room-state slots from inside the Durable Object. */
async function readSlots(stub: unknown): Promise<StoredSlot[]> {
  const state = (await runInDurableObject(
    stub as never,
    async (_i: unknown, s: DurableObjectState) => await s.storage.get("room-state"),
  )) as { slots?: StoredSlot[] } | undefined
  return state?.slots ?? []
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

  it("relays valid social reactions once per cooldown without blocking moves", async () => {
    const rid = roomId("social")
    const host = await openSocket(rid)
    const guest = await openSocket(rid)
    send(host, { type: "hello", guestId: "h" })
    await nextMessage(host)
    send(guest, { type: "hello", guestId: "g" })
    await nextMessage(guest)
    await nextMessage(host)

    send(host, { type: "social_reaction", id: "hello" })
    expect(JSON.parse(await nextMessage(guest))).toEqual({ type: "social_reaction", id: "hello" })
    send(host, { type: "social_reaction", id: "hello" })
    send(host, { type: "move", index: 4 })
    expect(JSON.parse(await nextMessage(guest))).toEqual({ type: "move", index: 4 })
    send(host, { type: "social_reaction", id: "arbitrary message" })
    await expectNoMessage(guest, "invalid reaction")
    host.close()
    guest.close()
  })

  it("keeps the social cooldown when a player reconnects", async () => {
    const rid = roomId("socialresume")
    const host = await openSocket(rid)
    const guest = await openSocket(rid)
    send(host, { type: "hello", guestId: "h" })
    const welcome = JSON.parse(await nextMessage(host))
    send(guest, { type: "hello", guestId: "g" })
    await nextMessage(guest)
    await nextMessage(host)
    send(host, { type: "social_reaction", id: "hello" })
    await nextMessage(guest)
    host.close()
    await nextMessage(guest)
    const rejoined = await openSocket(rid)
    send(rejoined, { type: "hello", guestId: "h", reconnectToken: welcome.reconnectToken })
    expect(JSON.parse(await nextMessage(rejoined)).type).toBe("welcome")
    await nextMessage(guest)
    send(rejoined, { type: "social_reaction", id: "wow" })
    await expectNoMessage(guest, "reconnect bypassed social cooldown")
    rejoined.close()
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
      new Request("https://test.invalid/?game=gambit-deck", {
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

    // webSocketClose runs async in the DO; if the second hello lands before
    // the first socket's close is processed, the seat still looks connected
    // and the welcome carries no role. Wait for the disconnect to persist
    // (same pattern as the MM-01 test below).
    const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(rid))
    for (let i = 0; i < 20; i++) {
      const slots = await readSlots(stub)
      if (slots.some((s) => s.guestId === "stable-id" && s.disconnectedAt !== null)) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }

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

    // webSocketClose runs async in the DO; if it lands after the attacker's
    // hello, the victim's peer-left broadcast reaches the attacker before the
    // error reply and the test flakes. Wait for the disconnect to persist.
    const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(rid))
    for (let i = 0; i < 20; i++) {
      const slots = await readSlots(stub)
      if (slots.some((s) => s.guestId === "victim" && s.disconnectedAt !== null)) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }

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

  // KNOWN LIMITATION, by design: an OPEN room (an invite link, or any room that
  // never received matchmaking's /expect allocation) has open guestId-claim
  // semantics, so a first hello for ANY unseen guestId gets a seat. Invite codes
  // are the only credential there. The body below asserts the stricter behaviour
  // and therefore fails; `it.fails` keeps it as a tripwire — if this ever starts
  // passing, open rooms became closed and the invite flow must be re-checked.
  // Matchmade rooms ARE closed: see "refuses a disclosed guestId without its
  // slotToken in an allocated room" below, and the F20/F22 allocation tests.
  it.fails("open invite rooms: a hello can still claim a disclosed guestId that never connected", async () => {
    const rid = roomId("preclaim")
    const host = await openSocket(rid)
    send(host, { type: "hello", guestId: "h", displayName: "H" })
    await nextMessage(host)

    // The opponent is disclosed as "victim" but has never connected.
    const attacker = await openSocket(rid)
    send(attacker, { type: "hello", guestId: "victim", displayName: "NotVictim" })
    const stolen = JSON.parse(await nextMessage(attacker, 1000, "claim of an unconnected id"))

    expect(stolen.type, "claiming an unconnected disclosed guestId must be refused").not.toBe(
      "welcome",
    )
    expect(
      stolen.reconnectToken,
      "no credential may be issued for an unallocated id",
    ).toBeUndefined()
    const slots = await readSlots(env.GAME_ROOM.get(env.GAME_ROOM.idFromName(rid)))
    expect(
      slots.map((s) => s.guestId),
      "only the connecting player holds a slot",
    ).toEqual(["h"])
  })

  it("refuses a disclosed guestId without its slotToken in an allocated room", async () => {
    // Same attack as the open-room tripwire above, but the room was allocated by
    // matchmaking: the opponent's guestId alone is no longer a capability.
    const rid = roomId("claimed")
    const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(rid))
    await stub.fetch(
      new Request("https://test.invalid/expect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slots: [
            { guestId: "h", token: "tokH", role: "host" },
            { guestId: "victim", token: "tokV", role: "guest" },
          ],
        }),
      }),
    )
    const host = await openSocket(rid)
    send(host, { type: "hello", guestId: "h", displayName: "H", slotToken: "tokH" })
    await nextMessage(host)

    const attacker = await openSocket(rid)
    send(attacker, { type: "hello", guestId: "victim", displayName: "NotVictim" })
    const refused = JSON.parse(await nextMessage(attacker, 1000, "claim without slotToken"))
    expect(refused.type).toBe("error")
    expect(refused.reconnectToken).toBeUndefined()
    expect((await readSlots(stub)).map((s) => s.guestId)).toEqual(["h"])
    host.close()
  })

  it("refuses to mint a credential for a pre-MM-01 slot's first claimant", async () => {
    const rid = roomId("legacy")
    const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(rid))
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.put("room-state", {
        game: "tictactoe",
        slots: [{ guestId: "old", displayName: "O", role: "host", disconnectedAt: 1 }],
      }),
    )

    // A pre-MM-01 slot has no credential to check, and the opponent learns
    // guestId from welcome/peer-joined — so "first claimant" is not evidence
    // of ownership. Handing this caller a fresh credential is the bug.
    const ws = await openSocket(rid)
    send(ws, { type: "hello", guestId: "old", displayName: "O" })
    const err = JSON.parse(await nextMessage(ws))
    expect(err.type).toBe("error")
    expect(err.message ?? err.reason ?? JSON.stringify(err)).toMatch(/legacy/i)
    ws.close()

    // The identity is retired, not migrated: no slot is left to claim, so a
    // second attempt cannot inherit it either.
    const persisted = (await runInDurableObject(stub, (_instance, state) =>
      state.storage.get("room-state"),
    )) as { slots?: unknown[] } | undefined
    expect(persisted?.slots ?? []).toHaveLength(0)

    // Rejoining as a new player works and mints a real credential, so the
    // legacy population drains instead of deadlocking the room.
    const fresh = await openSocket(rid)
    send(fresh, { type: "hello", guestId: "old-2", displayName: "O" })
    const welcome = JSON.parse(await nextMessage(fresh))
    expect(welcome.type).toBe("welcome")
    expect(welcome.reconnectToken).toMatch(/^[0-9a-f]{32}$/)
    fresh.close()
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

  // F395 contract. The peer-left reason is decided by one ternary in
  // room.ts: `code === 1000 && reason === "client closing" ? "closed" :
  // "disconnect"`. "closed" is TERMINAL — the peer durably records a win.
  // gambit-deck's RoomClient.closeForReconnect tears the socket down with
  // (4000, "reconnecting") precisely so a transient retry lands on the
  // "disconnect" side. Both existing tests close with NO code, so they only
  // ever exercised the implicit branch: inverting the condition — or matching
  // on the reason alone — would turn every automatic retry into a durable
  // false win and the whole suite would stay green. Pin both sides.
  it("maps a reconnect teardown (4000/reconnecting) to a TRANSIENT peer-left", async () => {
    const rid = roomId("retryclose")
    const host = await openSocket(rid)
    const guest = await openSocket(rid)
    send(host, { type: "hello", guestId: "h", displayName: "H" })
    await nextMessage(host)
    send(guest, { type: "hello", guestId: "g", displayName: "G" })
    await nextMessage(guest)
    await nextMessage(host) // peer-joined

    // Exactly what gambit-deck sends on an automatic retry.
    guest.close(4000, "reconnecting")
    const evt = JSON.parse(await nextMessage(host))
    expect(evt.type).toBe("peer-left")
    expect(evt.reason).toBe("disconnect")
    host.close()
  })

  it("keeps a voluntary departure (1000/client closing) TERMINAL", async () => {
    const rid = roomId("quitclose")
    const host = await openSocket(rid)
    const guest = await openSocket(rid)
    send(host, { type: "hello", guestId: "h", displayName: "H" })
    await nextMessage(host)
    send(guest, { type: "hello", guestId: "g", displayName: "G" })
    await nextMessage(guest)
    await nextMessage(host) // peer-joined

    // A real quit must keep reporting "closed" — the fix must not have
    // softened voluntary departures into transient ones.
    guest.close(1000, "client closing")
    const evt = JSON.parse(await nextMessage(host))
    expect(evt.type).toBe("peer-left")
    expect(evt.reason).toBe("closed")
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

  // F682 / UNO-RECONNECT-01. gambit-deck's useOnlineReconnect retries
  // reconnectOnline() on an escalating backoff — 800ms, 1.6s, 3.2s, 6.4s, 8s,
  // 8s plus jitter, so ~6 attempts across ~28-33s against a 30s
  // RECONNECT_GRACE_MS. Roughly half the grace window is spent reconnecting.
  //
  // I first assumed the alarm was set once and never restarted, and wrote the
  // test around that. Reading room.ts disproved it: a successful reconnect
  // clears `slot.disconnectedAt` in handleHello (:378), and the NEXT
  // webSocketClose re-runs in full — it re-marks the slot and calls
  // setAlarm(now + 30s) again (:231). So each disconnect cycle opens a FRESH
  // 30s window. That is the correct behaviour and the reason it is worth
  // pinning — a client that is still trying must keep its slot, and one that
  // stops must lose it 30s after its LAST attempt, not 30s after the first.
  // That second half is the real contract: the deadline must track the final
  // attempt, so the peer-left teardown and the re-armed alarm are both
  // re-observed on every cycle, not just the first.
  //
  // NOT covered, and deliberately not faked: that the deadline is pushed a
  // further 30s out per cycle. The alarm() handler drops ANY disconnected slot
  // when it fires — it never compares elapsed time against disconnectedAt — so
  // the 30s guarantee lives entirely in the scheduling, and a millisecond-scale
  // test env cannot distinguish a deadline set on cycle 1 from one set on cycle
  // 3 (mutating room.ts:275 leaves this test green). Proving that needs the
  // paired-client retry loop with real backoff, which is the fixture the
  // WORK.md P0 asks for and is still outstanding. Recorded, not papered over.
  it("keeps a disconnected slot when an unrelated hello timeout fires mid-grace", async () => {
    // A disconnect arms a 30s grace. A NEW socket that never says hello arms
    // a 10s handshake alarm, and that alarm becomes the earliest deadline.
    // When it fires it must expire only the pending socket — a player's slot
    // is reclaimable for its own full 30s regardless of what woke the alarm.
    //
    // Before the fix the handler removed every disconnected slot on any alarm
    // and recomputed the next deadline as now + 30s, so this pending timeout
    // deleted the legitimate slot ~10s in, cutting the grace short.
    const rid = roomId("alarmgrc")
    const host = await openSocket(rid)
    const guest = await openSocket(rid)
    send(host, { type: "hello", guestId: "h", displayName: "H" })
    await nextMessage(host)
    send(guest, { type: "hello", guestId: "g", displayName: "G" })
    const guestWelcome = JSON.parse(await nextMessage(guest))
    await nextMessage(host) // peer-joined

    const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(rid))
    const guestToken: string = guestWelcome.reconnectToken

    // Guest drops; the slot is held for 30s.
    guest.close(4000, "reconnecting")
    await nextMessage(host, 1000, "teardown")

    // Age the disconnect by 5s so the grace has a measurable remainder. The
    // suite runs in milliseconds, so without this the real deadline and a
    // re-derived `now + 30s` are indistinguishable and the assertion below
    // would pass against the bug.
    // 25s, not 5s: the slot's remaining 5s must be the EARLIEST outstanding
    // deadline, otherwise the pending hello's 10s timeout wins the Math.min
    // under both the fix and the bug and the re-arm assertion cannot tell
    // them apart.
    const AGED_BY_MS = 25_000
    await runInDurableObject(stub, async (_i, s) => {
      const stored = (await s.storage.get("room-state")) as {
        slots: Array<{ guestId: string; disconnectedAt: number | null }>
      }
      for (const slot of stored.slots) {
        if (slot.disconnectedAt !== null) slot.disconnectedAt -= AGED_BY_MS
      }
      await s.storage.put("room-state", stored)
    })

    const held = (await readSlots(stub)).find((slot) => slot.guestId === "g")
    expect(held, "slot held after teardown").toMatchObject({ disconnectedAt: expect.any(Number) })
    const graceArmed = await runInDurableObject(stub, (_i, s) => s.storage.getAlarm())
    expect(graceArmed, "grace armed on teardown").not.toBeNull()

    // An unrelated socket connects and never completes its hello, so the
    // handshake alarm becomes the earliest deadline.
    const pending = await openSocket(rid)
    const alarmBefore = await runInDurableObject(stub, (_i, s) => s.storage.getAlarm())
    expect(alarmBefore, "an alarm is scheduled while a slot is disconnected").not.toBeNull()
    expect(
      alarmBefore === null ? 0 : alarmBefore - Date.now(),
      "pending hello deadline is earlier than the player's 30s grace",
    ).toBeLessThan(29_000)

    // Fire that alarm. It is the handshake timeout, not the grace expiring.
    await runDurableObjectAlarm(stub)

    // The disconnected player's slot must survive, still reclaimable.
    const stillHeld = (await readSlots(stub)).find((slot) => slot.guestId === "g")
    expect(stillHeld, "slot survives an unrelated alarm mid-grace").toMatchObject({
      disconnectedAt: expect.any(Number),
    })

    // And the re-armed alarm must point at THAT slot's real deadline, not at
    // `now + 30s`. Re-deriving from `now` on every wake-up pushed the expiry
    // further out each time anything else woke the alarm, so a slot could be
    // kept alive indefinitely. Pinning it to the slot's own `disconnectedAt`
    // is what makes that impossible.
    const rearmed = await runInDurableObject(stub, (_i, s) => s.storage.getAlarm())
    expect(rearmed, "grace re-armed after the unrelated alarm").not.toBeNull()
    const disconnectedAt = stillHeld?.disconnectedAt
    expect(typeof disconnectedAt, "slot still carries its disconnect timestamp").toBe("number")
    expect(
      rearmed === null || typeof disconnectedAt !== "number" ? -1 : rearmed - disconnectedAt,
      "re-armed alarm is the slot's own deadline, not now + 30s",
    ).toBeLessThanOrEqual(30_000)

    // Drop the pending socket before reclaiming: the room admits MAX_SLOTS
    // live connections, so leaving a third one open just earns a 429.
    pending.close(1000, "done")

    // And the credential it was issued must still work.
    const back = await openSocket(rid)
    send(back, { type: "hello", guestId: "g", displayName: "G", reconnectToken: guestToken })
    const welcome = JSON.parse(await nextMessage(back, 1000, "reclaim after unrelated alarm"))
    expect(welcome.role, "original player reclaimed its own slot").toBe("guest")
    expect(JSON.parse(await nextMessage(host, 1000, "peer-reconnected")).type).toBe(
      "peer-reconnected",
    )
  })

  it("holds the slot across repeated reconnect cycles and re-arms the grace", async () => {
    const rid = roomId("recycle3")
    const host = await openSocket(rid)
    let guest = await openSocket(rid)
    send(host, { type: "hello", guestId: "h", displayName: "H" })
    await nextMessage(host)
    send(guest, { type: "hello", guestId: "g", displayName: "G" })
    const guestWelcome = JSON.parse(await nextMessage(guest))
    await nextMessage(host) // peer-joined

    // MM-01 moved the reconnect contract: a hello carrying only the public
    // guestId is refused, because the opponent learns that id. This test is
    // about the GRACE clock re-arming across cycles, not about how a peer
    // proves it is the same peer, so it now reconnects with the private
    // credential MM-01 issues and keeps every slot/alarm assertion below.
    const guestToken: string = guestWelcome.reconnectToken
    expect(guestToken).toMatch(/^[0-9a-f]{32}$/)

    const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(rid))

    for (let cycle = 1; cycle <= 3; cycle++) {
      guest.close(4000, "reconnecting")
      expect(JSON.parse(await nextMessage(host, 1000, `teardown ${cycle}`))).toMatchObject({
        type: "peer-left",
        reason: "disconnect",
      })

      // Still connected on this side, so the host keeps the slot, and it is
      // marked disconnected so the grace clock can expire it.
      const held = (await readSlots(stub)).find((slot) => slot.guestId === "g")
      expect(held, `slot held + marked disconnected after teardown ${cycle}`).toMatchObject({
        disconnectedAt: expect.any(Number),
      })
      expect(
        await runInDurableObject(stub, (_i, s) => s.storage.getAlarm()),
        `grace armed on teardown ${cycle}`,
      ).not.toBeNull()

      const back = await openSocket(rid)
      send(back, { type: "hello", guestId: "g", displayName: "G", reconnectToken: guestToken })
      await nextMessage(back, 1000, `reconnect ${cycle} welcome`)
      await nextMessage(host, 1000, `peer-reconnected ${cycle}`)
      guest = back
    }

    // Three full cycles later the grace is armed again and the slot is still
    // held. The alarm is checked rather than fired on purpose: firing it here
    // would release the slot and prove nothing about re-arming.
    guest.close(4000, "reconnecting")
    await nextMessage(host, 1000, "final teardown")
    const after = await readSlots(stub)
    expect(
      await runInDurableObject(stub, (_i, s) => s.storage.getAlarm()),
      "grace re-armed on the last teardown",
    ).not.toBeNull()
    expect(
      after.find((slot) => slot.guestId === "g"),
      "slot survives its own retries",
    ).toBeDefined()

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
          // Seeded ALREADY past its 30s grace. This used to be
          // `Date.now() - 1`, i.e. a slot with 29999ms of grace left, and the
          // handler removed it on any alarm — which is the very defect the
          // "unrelated hello timeout" test now pins. Expiry is only legitimate
          // once the slot's own window has elapsed.
          { guestId: "g", displayName: "G", role: "guest", disconnectedAt: Date.now() - 30_001 },
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

  it("keeps the first disconnect's reap deadline when a second slot disconnects later (A-14)", async () => {
    const rid = roomId("twoclose")
    const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(rid))
    const host = await openSocket(rid)
    send(host, { type: "hello", guestId: "h", displayName: "H" })
    await nextMessage(host)
    const guest = await openSocket(rid)
    send(guest, { type: "hello", guestId: "g", displayName: "G" })
    await nextMessage(guest)
    await nextMessage(host) // peer-joined

    host.close(1000, "client closing")
    await nextMessage(guest, 1000, "host peer-left")

    // The host's grace is 20 s in. When the guest drops too, the alarm must stay
    // at the HOST's remaining 10 s, not move out to a fresh 30 s from now.
    await runInDurableObject(stub, async (_i, s) => {
      const stored = (await s.storage.get("room-state")) as {
        slots: Array<{ guestId: string; disconnectedAt: number | null }>
      }
      for (const slot of stored.slots) {
        if (slot.disconnectedAt !== null) slot.disconnectedAt -= 20_000
      }
      await s.storage.put("room-state", stored)
    })
    guest.close(1000, "client closing")
    for (let i = 0; i < 40; i += 1) {
      if ((await readSlots(stub)).every((slot) => slot.disconnectedAt !== null)) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect((await readSlots(stub)).every((slot) => slot.disconnectedAt !== null)).toBe(true)

    const alarm = await runInDurableObject(stub, (_i, s) => s.storage.getAlarm())
    expect(alarm).not.toBeNull()
    expect((alarm ?? 0) - Date.now()).toBeLessThan(11_000)
  })

  // Item 12 (tic-tac-toe client report). A hello that NAMES a role must not be
  // silently seated as the other one: creating invite room "friday-game" with
  // role:"host" while someone else already holds that seat used to seat the
  // second caller as guest, announce peer-joined to the real host, and end the
  // room when the "guest" then left. Hellos that name no role stay first-come.
  describe("a requested role that another guestId already holds", () => {
    async function seat(rid: string, guestId: string, role?: "host" | "guest") {
      const ws = await openSocket(rid)
      send(ws, { type: "hello", guestId, displayName: guestId, ...(role ? { role } : {}) })
      return { ws, welcome: JSON.parse(await nextMessage(ws, 1000, `${guestId} welcome`)) }
    }

    for (const [taken, label] of [
      ["host", "host seat"],
      ["guest", "guest seat"],
    ] as const) {
      it(`refuses a second claim on the ${label} before welcome and tells the holder nothing`, async () => {
        const rid = roomId(`taken${taken}`)
        const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(rid))
        const holder = await seat(rid, "holder", taken)
        expect(holder.welcome).toMatchObject({ type: "welcome", role: taken })

        const intruder = await openSocket(rid)
        const refused = nextMessage(intruder, 1000, "role-taken error")
        send(intruder, { type: "hello", guestId: "intruder", displayName: "I", role: taken })
        expect(JSON.parse(await refused)).toEqual({
          type: "error",
          code: "role-taken",
          message: "That room code is already in use",
        })
        await expectNoMessage(holder.ws, "the seated player must not hear about the refused claim")
        expect((await readSlots(stub)).map((slot) => slot.guestId)).toEqual(["holder"])
        holder.ws.close()
        intruder.close()
      })
    }

    it("still seats a hello that names the OTHER, free role", async () => {
      const rid = roomId("freerole")
      const host = await seat(rid, "h", "host")
      const guest = await seat(rid, "g", "guest")
      expect(guest.welcome).toMatchObject({ type: "welcome", role: "guest" })
      expect(JSON.parse(await nextMessage(host.ws, 1000, "peer-joined")).type).toBe("peer-joined")
      host.ws.close()
      guest.ws.close()
    })

    it("keeps first-come seating when the hello names no role", async () => {
      const rid = roomId("norole")
      const first = await seat(rid, "a")
      const second = await seat(rid, "b")
      expect(first.welcome.role).toBe("host")
      expect(second.welcome.role).toBe("guest")
      first.ws.close()
      second.ws.close()
    })

    it("lets the holder reconnect with its token while naming its own role", async () => {
      const rid = roomId("rolerecon")
      const host = await seat(rid, "h", "host")
      const guest = await seat(rid, "g", "guest")
      await nextMessage(host.ws, 1000, "peer-joined")

      host.ws.close(4000, "reconnecting")
      await nextMessage(guest.ws, 1000, "peer-left")
      const back = await openSocket(rid)
      send(back, {
        type: "hello",
        guestId: "h",
        displayName: "h",
        role: "host",
        reconnectToken: host.welcome.reconnectToken,
      })
      expect(JSON.parse(await nextMessage(back, 1000, "reconnect welcome"))).toMatchObject({
        type: "welcome",
        role: "host",
      })
      back.close()
      guest.ws.close()
    })

    it("does not apply to an allocated room: the slotToken decides the role", async () => {
      const rid = roomId("allocrole")
      const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(rid))
      await pushExpect(stub, [
        { guestId: "h1", token: "tokH", role: "host" },
        { guestId: "g1", token: "tokG", role: "guest" },
      ])
      const host = await openSocket(rid)
      send(host, { type: "hello", guestId: "h1", displayName: "H", slotToken: "tokH" })
      await nextMessage(host)
      const guest = await openSocket(rid)
      // The allocated guest names "host" by mistake; the allocation wins.
      send(guest, {
        type: "hello",
        guestId: "g1",
        displayName: "G",
        slotToken: "tokG",
        role: "host",
      })
      expect(JSON.parse(await nextMessage(guest, 1000, "allocated welcome"))).toMatchObject({
        type: "welcome",
        role: "guest",
      })
      host.close()
      guest.close()
    })
  })

  it("does not relay frames to a socket that has not said hello (A-15)", async () => {
    const rid = roomId("pendfan")
    const host = await openSocket(rid)
    send(host, { type: "hello", guestId: "h", displayName: "H" })
    await nextMessage(host)

    // Connected, no hello yet: not a player, so not an audience.
    const lurker = await openSocket(rid)
    send(host, { type: "move", cell: 4 })
    await expectNoMessage(lurker, "frame relayed to an unauthenticated socket")
    host.close()
    lurker.close()
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
  // neither, so anything carrying them came from a peer. `player_left` is
  // the same class (F734): the DO's heartbeat/end variant of peer-left, and
  // the client records a match result on receiving it — while no server code
  // and no client send path ever produces it.
  for (const forged of ["room_closed", "host_migrated", "player_left"]) {
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
      new Request("https://test.invalid/?game=not-a-game", {
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

  // F20. A queued player learns the future roomId from `waiting` responses
  // while the room is still open-claim, so they can connect and seat
  // themselves before matchmaking's /expect handoff lands. The merge used to
  // leave those seats in place: the squatter either dead-on-arrival'd the
  // match (room full when the allocated players arrived) or sat on an
  // allocated guestId and forced the real owner through the reconnect path
  // it cannot satisfy. The contract: an allocation push EVICTS every seat
  // that was not itself minted through that allocation's token.
  async function pushExpect(
    stub: unknown,
    slots: Array<{ guestId: string; token: string; role: "host" | "guest" }>,
  ): Promise<Response> {
    return (stub as { fetch(req: Request): Promise<Response> }).fetch(
      new Request("https://test.invalid/expect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slots }),
      }),
    )
  }

  it("cancel releases a seated peer, spares the leaver, and leaves no state behind (A-13)", async () => {
    const rid = roomId("cancel")
    const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(rid))
    const cancel = (body: unknown) =>
      stub.fetch(
        new Request("https://test.invalid/cancel", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      )

    expect((await cancel({})).status).toBe(400)
    expect((await cancel({ guestId: "g1" })).status).toBe(200)
    expect(await runInDurableObject(stub, (_i, s) => s.storage.get("room-state"))).toBeUndefined()

    expect(
      (
        await pushExpect(stub, [
          { guestId: "h1", token: "tokH", role: "host" },
          { guestId: "g1", token: "tokG", role: "guest" },
        ])
      ).status,
    ).toBe(200)
    const host = await openSocket(rid)
    send(host, { type: "hello", guestId: "h1", displayName: "H", slotToken: "tokH" })
    await nextMessage(host)
    const guest = await openSocket(rid)
    send(guest, { type: "hello", guestId: "g1", displayName: "G", slotToken: "tokG" })
    await nextMessage(guest)
    await nextMessage(host) // peer-joined

    // g1 cancels: h1 is told the room is closed, g1 is not told about itself.
    const closed = nextMessage(host)
    expect((await cancel({ guestId: "g1" })).status).toBe(200)
    expect(JSON.parse(await closed)).toEqual({ type: "peer-left", reason: "closed" })
    await expectNoMessage(guest, "the leaver must not be told it left")
    const stored = (await runInDurableObject(stub, (_i, s) => s.storage.get("room-state"))) as {
      expected?: unknown
    }
    expect(stored.expected).toBeUndefined()
    host.close()
    guest.close()
  })

  it("evicts an open-claim squatter when the allocation lands (F20)", async () => {
    const rid = roomId("squatnew")
    const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(rid))

    // The squatter's window: a waiting response disclosed `rid` while the
    // room is unallocated, so this hello binds nothing but the id itself.
    const squatter = await openSocket(rid)
    send(squatter, { type: "hello", guestId: "squatter", displayName: "S", role: "host" })
    expect(JSON.parse(await nextMessage(squatter, 1000, "squatter welcome")).type).toBe("welcome")

    const resp = await pushExpect(stub, [
      { guestId: "h1", token: "tokH", role: "host" },
      { guestId: "g1", token: "tokG", role: "guest" },
    ])
    expect(resp.status).toBe(200)

    // The squatted seat must be gone, not just fenced off by the expected map.
    expect((await readSlots(stub)).map((s) => s.guestId)).toEqual([])

    // Both allocated players must be able to claim their seats with the token.
    const host = await openSocket(rid)
    send(host, { type: "hello", guestId: "h1", displayName: "H", slotToken: "tokH" })
    const hostWelcome = JSON.parse(await nextMessage(host, 1000, "allocated host welcome"))
    expect(hostWelcome).toMatchObject({ type: "welcome", role: "host" })

    const guest = await openSocket(rid)
    send(guest, { type: "hello", guestId: "g1", displayName: "G", slotToken: "tokG" })
    expect(JSON.parse(await nextMessage(guest, 1000, "allocated guest welcome"))).toMatchObject({
      type: "welcome",
      role: "guest",
    })

    host.close()
    guest.close()
  })

  it("promotes the ticket-holder's own early seat instead of evicting it (F20)", async () => {
    const rid = roomId("earlyseat")
    const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(rid))

    // tic-tac-toe hosts its relay room while searching: the waiting player
    // sits under its OWN guestId before the allocation exists. That seat is
    // provably the ticket-holder's — only they know (roomId, guestId) before
    // the push, since matchmaking withholds `matched` until /expect lands —
    // so /expect binds it rather than evicting it. Evicting it tore a seat
    // window where the matched peer's first frames fan out to zero sockets
    // and the pair deadlocks on "Waiting for opponent".
    const early = await openSocket(rid)
    send(early, { type: "hello", guestId: "h1", displayName: "H", role: "host" })
    const earlyWelcome = JSON.parse(await nextMessage(early, 1000, "early welcome"))
    expect(earlyWelcome.type).toBe("welcome")

    const resp = await pushExpect(stub, [
      { guestId: "h1", token: "tokH", role: "host" },
      { guestId: "g1", token: "tokG", role: "guest" },
    ])
    expect(resp.status).toBe(200)

    // The early seat survived, token-bound, and its socket was never closed.
    expect((await readSlots(stub)).map((s) => s.guestId)).toEqual(["h1"])
    expect(early.readyState).toBe(WebSocket.OPEN)

    // The matched peer seats through the token and reaches the held seat —
    // peer-joined lands on the still-open socket, no transition gap.
    const guest = await openSocket(rid)
    send(guest, { type: "hello", guestId: "g1", displayName: "G", slotToken: "tokG" })
    const guestWelcome = JSON.parse(await nextMessage(guest, 1000, "guest welcome"))
    expect(guestWelcome).toMatchObject({ type: "welcome", role: "guest" })
    expect(guestWelcome.opponent?.guestId).toBe("h1")
    const joined = JSON.parse(await nextMessage(early, 1000, "peer-joined on early seat"))
    expect(joined).toMatchObject({ type: "peer-joined" })

    early.close()
    guest.close()
  })

  it("still evicts a pre-allocation seat that fails the role check (F20)", async () => {
    const rid = roomId("earlyrole")
    const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(rid))

    // Promotion requires the allocation's role too — a seat under the right
    // guestId but a different role is not the ticket-holder's hold.
    const squatter = await openSocket(rid)
    send(squatter, { type: "hello", guestId: "h1", displayName: "S", role: "guest" })
    expect(JSON.parse(await nextMessage(squatter, 1000, "squatter welcome")).type).toBe("welcome")

    const resp = await pushExpect(stub, [
      { guestId: "h1", token: "tokH", role: "host" },
      { guestId: "g1", token: "tokG", role: "guest" },
    ])
    expect(resp.status).toBe(200)
    expect((await readSlots(stub)).map((s) => s.guestId)).toEqual([])
    expect(squatter.readyState).not.toBe(WebSocket.OPEN)

    squatter.close()
  })

  it("does not promote a seat under a guestId the push already knew (F20)", async () => {
    const rid = roomId("noremote")
    const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(rid))
    const slots = [
      { guestId: "h1", token: "tokH", role: "host" as const },
      { guestId: "g1", token: "tokG", role: "guest" as const },
    ]

    // After the first push, `matched` has disclosed roomId + guestIds — a
    // non-token seat under an allocated id can now be a genuine squat, so a
    // re-push must evict rather than promote it.
    expect((await pushExpect(stub, slots)).status).toBe(200)
    const squatter = await openSocket(rid)
    send(squatter, {
      type: "hello",
      guestId: "h1",
      displayName: "S",
      role: "host",
      slotToken: "wrong",
    })
    expect(JSON.parse(await nextMessage(squatter, 1000, "squatter refused")).type).toBe("error")
    squatter.close()

    // A second hello path that bypasses the token (open-claim) cannot exist
    // while expected is armed, so simulate the seat directly: the filter on
    // re-push must still remove non-viaExpect rows.
    await runInDurableObject(stub, async (_state, state2) => {
      await state2.storage.put("slots", [
        { guestId: "h1", role: "host", displayName: "S", disconnectedAt: null },
      ])
    })
    expect((await pushExpect(stub, slots)).status).toBe(200)
    expect((await readSlots(stub)).map((s) => s.guestId)).toEqual([])
  })

  it("keeps token-seated slots across an idempotent /expect re-push", async () => {
    // bindRoomSlots retries the handoff until the match is marked bound; a
    // re-push must not evict a player who already claimed with its token.
    const rid = roomId("reexpect")
    const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(rid))
    const slots = [
      { guestId: "h1", token: "tokH", role: "host" as const },
      { guestId: "g1", token: "tokG", role: "guest" as const },
    ]

    expect((await pushExpect(stub, slots)).status).toBe(200)
    const host = await openSocket(rid)
    send(host, { type: "hello", guestId: "h1", displayName: "H", slotToken: "tokH" })
    expect(JSON.parse(await nextMessage(host, 1000, "token welcome")).type).toBe("welcome")

    expect((await pushExpect(stub, slots)).status).toBe(200)
    expect((await readSlots(stub)).map((s) => s.guestId)).toEqual(["h1"])
    expect(host.readyState).toBe(WebSocket.OPEN)

    host.close()
  })

  // F22. Reaping a slot dropped the row but left `state.expected` armed:
  // when BOTH players' slots died (mutual outage past the 30s grace), the
  // room kept demanding a slotToken nobody could still present — a refreshed
  // client persists only reconnectToken — so the room was wedged forever.
  // The contract: a reap that empties the room retires the allocation; a
  // reap with a peer still seated keeps it (a slotToken bearer may still
  // legitimately reclaim, and strangers must stay refused).
  it("retires the allocation only once every seated slot is reaped (F22)", async () => {
    const rid = roomId("wedgefix")
    const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(rid))
    await pushExpect(stub, [
      { guestId: "h1", token: "tokH", role: "host" },
      { guestId: "g1", token: "tokG", role: "guest" },
    ])

    const host = await openSocket(rid)
    send(host, { type: "hello", guestId: "h1", displayName: "H", slotToken: "tokH" })
    await nextMessage(host, 1000, "host welcome")
    const guest = await openSocket(rid)
    send(guest, { type: "hello", guestId: "g1", displayName: "G", slotToken: "tokG" })
    await nextMessage(guest, 1000, "guest welcome")
    await nextMessage(host, 1000, "peer-joined")

    // Guest dies past its grace; host is still seated.
    guest.close(4000, "reconnecting")
    await nextMessage(host, 1000, "guest teardown")
    await runInDurableObject(stub, async (_i, s) => {
      const stored = (await s.storage.get("room-state")) as {
        slots: Array<{ guestId: string; disconnectedAt: number | null }>
      }
      for (const slot of stored.slots) {
        if (slot.disconnectedAt !== null) slot.disconnectedAt -= 31_000
      }
      await s.storage.put("room-state", stored)
    })
    await runDurableObjectAlarm(stub)
    expect((await readSlots(stub)).map((s) => s.guestId)).toEqual(["h1"])

    // While the host remains, the allocation is still live: a stranger is
    // refused, but the reaped player can reclaim with its slotToken.
    const stranger = await openSocket(rid)
    send(stranger, { type: "hello", guestId: "c", displayName: "C" })
    expect(JSON.parse(await nextMessage(stranger, 1000, "stranger refusal"))).toMatchObject({
      type: "error",
      code: "invalid",
    })
    stranger.close()

    const back = await openSocket(rid)
    send(back, { type: "hello", guestId: "g1", displayName: "G", slotToken: "tokG" })
    expect(JSON.parse(await nextMessage(back, 1000, "token reclaim"))).toMatchObject({
      type: "welcome",
      role: "guest",
    })

    // Now both die past grace — the match is over for good.
    back.close(4000, "reconnecting")
    await nextMessage(host, 1000, "guest teardown 2")
    host.close(4000, "reconnecting")
    // Nobody remains to observe a peer-left for the host, so poll storage:
    // the close handler must have persisted disconnectedAt before the aging
    // write below, otherwise the slot is reaped on a stale read.
    for (let i = 0; i < 50; i++) {
      const hostSlot = (await readSlots(stub)).find((s) => s.guestId === "h1")
      if (hostSlot?.disconnectedAt !== null && hostSlot?.disconnectedAt !== undefined) break
      await new Promise((r) => setTimeout(r, 20))
    }
    await runInDurableObject(stub, async (_i, s) => {
      const stored = (await s.storage.get("room-state")) as {
        slots: Array<{ guestId: string; disconnectedAt: number | null }>
      }
      for (const slot of stored.slots) {
        if (slot.disconnectedAt !== null) slot.disconnectedAt -= 31_000
      }
      await s.storage.put("room-state", stored)
    })
    await runDurableObjectAlarm(stub)
    expect(await readSlots(stub)).toEqual([])

    // The dead room reverts to open claim instead of fossilizing behind an
    // expectation nobody can satisfy.
    const fresh = await openSocket(rid)
    send(fresh, { type: "hello", guestId: "late", displayName: "L" })
    expect(JSON.parse(await nextMessage(fresh, 1000, "post-wedge welcome")).type).toBe("welcome")
    fresh.close()
  })

  // Never-seated seats. Before this, an `expected` entry had no deadline:
  // a host whose first connect failed left its allocated guest on
  // "Waiting for host…" forever, and a guest that never joined parked the
  // host the same way — the reap only looked at seated slots, and with zero
  // connected sockets nothing armed the alarm at all. The contract: each
  // allocation entry carries its own seat-fill deadline; the alarm expires
  // an unclaimed one and releases the waiting peer with `peer-left expired`.
  async function ageExpectedEntries(
    stub: unknown,
    guestIds: string[],
    agedByMs: number,
  ): Promise<void> {
    await runInDurableObject(stub as never, async (_i: unknown, s: DurableObjectState) => {
      const stored = (await s.storage.get("room-state")) as {
        expected?: Record<string, { armedAt?: number }>
      }
      if (!stored.expected) return
      for (const id of guestIds) {
        const entry = stored.expected[id]
        if (entry) entry.armedAt = (entry.armedAt ?? Date.now()) - agedByMs
      }
      await s.storage.put("room-state", stored)
    })
  }

  it("arms the seat deadline when an allocation lands on an empty room", async () => {
    const rid = roomId("armedseat")
    const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(rid))
    await pushExpect(stub, [
      { guestId: "h1", token: "tokH", role: "host" },
      { guestId: "g1", token: "tokG", role: "guest" },
    ])
    expect(await runInDurableObject(stub, (_i, s) => s.storage.getAlarm())).not.toBeNull()
  })

  it("expires the seat an allocated peer never claims and releases the waiter", async () => {
    const rid = roomId("neverhere")
    const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(rid))
    await pushExpect(stub, [
      { guestId: "h1", token: "tokH", role: "host" },
      { guestId: "g1", token: "tokG", role: "guest" },
    ])

    const host = await openSocket(rid)
    send(host, { type: "hello", guestId: "h1", displayName: "H", slotToken: "tokH" })
    expect(JSON.parse(await nextMessage(host, 1000, "host welcome")).type).toBe("welcome")

    // The allocated guest never connects. Age its entry past the deadline.
    // The listener attaches before the alarm: frames are not buffered for
    // late listeners in this pool.
    const peerLeft = nextMessage(host, 2000, "peer-left")
    await ageExpectedEntries(stub, ["g1"], 61_000)
    await runDurableObjectAlarm(stub)

    expect(JSON.parse(await peerLeft)).toMatchObject({
      type: "peer-left",
      reason: "expired",
    })

    // g1's capability is gone — a late claim arrives to open-claim refusal…
    const stored = await runInDurableObject(stub, async (_i, s) => {
      return (await s.storage.get("room-state")) as {
        expected?: Record<string, unknown>
      }
    })
    // …while the seated host's own claimed entry stays armed.
    expect(Object.keys(stored.expected ?? {})).toEqual(["h1"])

    host.close()
  })

  it("retires a fully absent allocation with nobody to notify", async () => {
    const rid = roomId("allabsent")
    const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(rid))
    await pushExpect(stub, [
      { guestId: "h1", token: "tokH", role: "host" },
      { guestId: "g1", token: "tokG", role: "guest" },
    ])
    await ageExpectedEntries(stub, ["h1", "g1"], 61_000)
    await runDurableObjectAlarm(stub)

    const stored = await runInDurableObject(stub, async (_i, s) => {
      return (await s.storage.get("room-state")) as {
        expected?: Record<string, unknown>
      }
    })
    // Retired rooms leave no stored state at all (storage hygiene): the
    // armed allocation is gone with the key, and loadState rebuilds the
    // open-claim default on next touch.
    expect(stored).toBeUndefined()
    // Inert room: no outstanding deadline means no alarm stays armed.
    expect(await runInDurableObject(stub, (_i, s) => s.storage.getAlarm())).toBeNull()

    // And a latecomer lands on the reverted open-claim room.
    const late = await openSocket(rid)
    send(late, { type: "hello", guestId: "late", displayName: "L" })
    expect(JSON.parse(await nextMessage(late, 1000, "late welcome")).type).toBe("welcome")
    late.close()
  })

  it("keeps both seats when the allocated pair claims them in time", async () => {
    const rid = roomId("bothclaim")
    const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(rid))
    await pushExpect(stub, [
      { guestId: "h1", token: "tokH", role: "host" },
      { guestId: "g1", token: "tokG", role: "guest" },
    ])
    const host = await openSocket(rid)
    send(host, { type: "hello", guestId: "h1", displayName: "H", slotToken: "tokH" })
    await nextMessage(host, 1000, "host welcome")
    const guest = await openSocket(rid)
    send(guest, { type: "hello", guestId: "g1", displayName: "G", slotToken: "tokG" })
    await nextMessage(guest, 1000, "guest welcome")
    await nextMessage(host, 1000, "peer-joined")

    // Even a stale-armed entry is safe once its seat exists: the reap only
    // looks at entries nobody claimed. Listeners attach before the alarm so
    // a wrongly-sent frame cannot slip past unobserved.
    const noHost = expectNoMessage(host, "no peer-left with both seats filled")
    const noGuest = expectNoMessage(guest, "no peer-left with both seats filled")
    await ageExpectedEntries(stub, ["h1", "g1"], 61_000)
    await runDurableObjectAlarm(stub)
    expect((await readSlots(stub)).map((s) => s.guestId)).toEqual(["h1", "g1"])
    await noHost
    await noGuest

    host.close()
    guest.close()
  })

  it("deletes persisted state when the alarm reaps the last seat", async () => {
    const rid = roomId("retire")
    const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(rid))
    // One disconnected, long-expired slot; no sockets, no armed allocations.
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.put("room-state", {
        game: "tictactoe",
        slots: [{ guestId: "h", displayName: "H", role: "host", disconnectedAt: 1 }],
      }),
    )
    await runInDurableObject(stub, (_instance, state) => state.storage.setAlarm(Date.now()))
    await runDurableObjectAlarm(stub)
    const persisted = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get("room-state"),
    )
    expect(persisted, "retired room leaves no stored state").toBeUndefined()
    const alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())
    expect(alarm, "no alarm survives a retired room").toBeNull()
  })
})
