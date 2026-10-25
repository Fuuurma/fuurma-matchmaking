import { afterEach, describe, expect, it, vi } from "vitest"
import type { StorageLike } from "../../src/identity"
import type { MessageDataEvent } from "../../src/socket"
import { RoomSocket } from "../../src/socket"

class FakeSocket {
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: FakeSocket[] = []
  readyState = 0
  readonly url: string
  readonly sent: string[] = []
  closeFrame: { code?: number; reason?: string } | null = null
  private readonly handlers = new Map<string, Array<(event: MessageDataEvent) => void>>()

  constructor(url: string) {
    this.url = url
    FakeSocket.instances.push(this)
  }

  addEventListener(type: string, fn: (event: MessageDataEvent) => void): void {
    const list = this.handlers.get(type) ?? []
    list.push(fn)
    this.handlers.set(type, list)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.closeFrame = { code, reason }
    this.readyState = FakeSocket.CLOSED
    this.emit("close")
  }

  emit(type: string, event?: unknown): void {
    if (type === "open") this.readyState = FakeSocket.OPEN
    for (const fn of this.handlers.get(type) ?? []) fn((event ?? {}) as MessageDataEvent)
  }
}

const HANDSHAKE_TIMEOUT_MS = 10_000

function memory(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  }
}

function makeSocket(
  statuses: string[],
  opts?: Partial<ConstructorParameters<typeof RoomSocket>[0]>,
): RoomSocket {
  const socket = new RoomSocket({
    displayName: "Tester",
    game: "tictactoe",
    guestId: "guest:1",
    role: "guest",
    socket: (url: string) => new FakeSocket(url),
    storage: memory(),
    wsUrl: "ws://relay.test/room/ABCDEF1234567890",
    ...opts,
  })
  socket.setStatusHandler((status) => statuses.push(status))
  return socket
}

function welcome(socket: FakeSocket, extra?: Record<string, unknown>): void {
  socket.emit("open")
  socket.emit("message", {
    data: JSON.stringify({ opponent: null, role: "guest", type: "welcome", ...extra }),
  })
}

afterEach(() => {
  FakeSocket.instances = []
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("reconnect gating (T F151: only established sessions retry)", () => {
  it("does not auto-reconnect when the initial socket dies before welcome", async () => {
    const statuses: string[] = []
    const client = makeSocket(statuses)
    const pending = client.connect()
    FakeSocket.instances[0].close()
    await expect(pending).rejects.toThrow("socket closed before welcome")
    expect(statuses).not.toContain("reconnecting")
    expect(statuses.at(-1)).toBe("disconnected")
    expect(FakeSocket.instances).toHaveLength(1)
  })

  it("auto-reconnects when an established session drops", async () => {
    vi.useFakeTimers()
    const statuses: string[] = []
    const client = makeSocket(statuses)
    const pending = client.connect()
    welcome(FakeSocket.instances[0])
    await expect(pending).resolves.toMatchObject({ role: "guest" })
    FakeSocket.instances[0].close()
    expect(statuses).toContain("reconnecting")
    client.close()
  })

  it("auto-reconnects when an established session errors before close", async () => {
    vi.useFakeTimers()
    const statuses: string[] = []
    const client = makeSocket(statuses)
    const pending = client.connect()
    welcome(FakeSocket.instances[0])
    await expect(pending).resolves.toMatchObject({ role: "guest" })
    FakeSocket.instances[0].emit("error")
    FakeSocket.instances[0].close()
    expect(statuses).toContain("reconnecting")
    client.close()
  })

  it("a pre-welcome error followed by close stays terminal", async () => {
    const statuses: string[] = []
    const client = makeSocket(statuses)
    const pending = client.connect()
    FakeSocket.instances[0].emit("error")
    FakeSocket.instances[0].close()
    await expect(pending).rejects.toThrow("socket error")
    expect(statuses).not.toContain("reconnecting")
    expect(FakeSocket.instances).toHaveLength(1)
  })

  it("stops retrying once the attempt budget is spent", async () => {
    vi.useFakeTimers()
    const statuses: string[] = []
    const client = makeSocket(statuses, { reconnect: { maxAttempts: 2, baseMs: 800, maxMs: 8000 } })
    const pending = client.connect()
    welcome(FakeSocket.instances[0])
    await expect(pending).resolves.toMatchObject({ role: "guest" })
    // Drop every socket, including retries, immediately.
    FakeSocket.instances[0].close()
    await vi.advanceTimersByTimeAsync(60_000)
    FakeSocket.instances[1].close()
    await vi.advanceTimersByTimeAsync(60_000)
    FakeSocket.instances[2].close()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeSocket.instances).toHaveLength(3) // initial + 2 retries
    expect(statuses.at(-1)).toBe("disconnected")
    client.close()
  })
})

describe("pre-welcome relay error capture (T F253, G refusal cases)", () => {
  it("a pre-welcome relay error frame becomes the rejection reason", async () => {
    const statuses: string[] = []
    const client = makeSocket(statuses)
    const pending = client.connect()
    const ws = FakeSocket.instances[0]
    ws.emit("message", {
      data: JSON.stringify({ code: "unknown", message: "Room is full", type: "error" }),
    })
    ws.close()
    await expect(pending).rejects.toThrow("Room is full")
    expect(statuses.at(-1)).toBe("disconnected")
  })

  it("the rejection carries the mapped error code", async () => {
    const client = makeSocket([])
    const pending = client.connect()
    const ws = FakeSocket.instances[0]
    ws.emit("message", {
      data: JSON.stringify({ code: "unknown", message: "room full", type: "error" }),
    })
    ws.close()
    const err = await pending.then(
      () => null,
      (e: unknown) => e as { code?: string },
    )
    expect(err?.code).toBe("room-full")
    client.close()
  })

  it("keeps the refusal when the error event lands before the close", async () => {
    const client = makeSocket([])
    const pending = client.connect()
    const ws = FakeSocket.instances[0]
    ws.emit("open")
    ws.emit("message", {
      data: JSON.stringify({ code: "invalid", message: "join capability required", type: "error" }),
    })
    ws.emit("error")
    ws.close()
    const err = await pending.then(
      () => null,
      (e: unknown) => e as { code?: string; message?: string },
    )
    expect(err?.code).toBe("capability")
    expect(err?.message).toBe("join capability required")
    client.close()
  })

  it("does not carry a refusal into the next attempt's rejection", async () => {
    const client = makeSocket([])
    const first = client.connect()
    FakeSocket.instances[0].emit("message", {
      data: JSON.stringify({ code: "unknown", message: "room full", type: "error" }),
    })
    FakeSocket.instances[0].close()
    await expect(first).rejects.toThrow("room full")
    const second = client.connect()
    FakeSocket.instances[1].close()
    await expect(second).rejects.toThrow("socket closed before welcome")
    client.close()
  })
})

describe("hello-send failures (T F746)", () => {
  it("re-arms the retry when a reconnect hello cannot be sent", async () => {
    vi.useFakeTimers()
    const statuses: string[] = []
    const client = makeSocket(statuses)
    const pending = client.connect()
    welcome(FakeSocket.instances[0])
    await expect(pending).resolves.toMatchObject({ role: "guest" })
    FakeSocket.instances[0].close()
    await vi.runOnlyPendingTimersAsync()
    expect(FakeSocket.instances).toHaveLength(2)
    const retry = FakeSocket.instances[1]
    retry.send = () => {
      throw new Error("send failed")
    }
    retry.emit("open")
    expect(statuses.at(-1)).toBe("reconnecting")
    await vi.runOnlyPendingTimersAsync()
    expect(FakeSocket.instances).toHaveLength(3)
    client.close()
  })

  it("a hello send failure on the initial connect stays terminal", async () => {
    const statuses: string[] = []
    const client = makeSocket(statuses)
    const pending = client.connect()
    const ws = FakeSocket.instances[0]
    ws.send = () => {
      throw new Error("send failed")
    }
    ws.emit("open")
    await expect(pending).rejects.toThrow("hello send failed")
    expect(statuses).not.toContain("reconnecting")
    expect(statuses.at(-1)).toBe("disconnected")
    expect(FakeSocket.instances).toHaveLength(1)
  })
})

describe("handshake deadline + attempt supersession (T F460, G F892)", () => {
  it("settles and closes the socket when it never opens", async () => {
    vi.useFakeTimers()
    const statuses: string[] = []
    const client = makeSocket(statuses)
    const pending = client.connect()
    const settled = expect(pending).rejects.toThrow(/timed out/i)
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS + 1)
    await settled
    expect(FakeSocket.instances[0].readyState).toBe(FakeSocket.CLOSED)
    expect(statuses).not.toContain("reconnecting")
    expect(statuses.at(-1)).toBe("disconnected")
    expect(FakeSocket.instances).toHaveLength(1)
  })

  it("settles and closes the socket when it opens without a welcome", async () => {
    vi.useFakeTimers()
    const statuses: string[] = []
    const client = makeSocket(statuses)
    const pending = client.connect()
    const settled = expect(pending).rejects.toThrow(/timed out/i)
    FakeSocket.instances[0].emit("open")
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS + 1)
    await settled
    expect(client.isConnected()).toBe(false)
    expect(statuses.at(-1)).toBe("disconnected")
  })

  it("settles a close racing the deadline exactly once", async () => {
    vi.useFakeTimers()
    const statuses: string[] = []
    const client = makeSocket(statuses)
    const pending = client.connect()
    const settled = expect(pending).rejects.toThrow()
    const ws = FakeSocket.instances[0]
    setTimeout(() => ws.close(), HANDSHAKE_TIMEOUT_MS)
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS + 1)
    await settled
    expect(statuses.filter((s) => s === "disconnected")).toHaveLength(1)
    expect(FakeSocket.instances).toHaveLength(1)
  })

  it("ignores a welcome that arrives after the deadline settled", async () => {
    vi.useFakeTimers()
    const statuses: string[] = []
    const client = makeSocket(statuses)
    const messages: unknown[] = []
    client.setMessageHandler((msg) => messages.push(msg))
    const pending = client.connect()
    const settled = expect(pending).rejects.toThrow(/timed out/i)
    const ws = FakeSocket.instances[0]
    ws.emit("open")
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS + 1)
    await settled
    ws.emit("message", {
      data: JSON.stringify({ opponent: null, role: "guest", type: "welcome" }),
    })
    expect(messages).toHaveLength(0)
    expect(statuses).not.toContain("connected")
    expect(client.getRole()).toBeNull()
    expect(client.isConnected()).toBe(false)
  })

  it("resumes bounded retry after a timed-out reconnect of an established session", async () => {
    vi.useFakeTimers()
    const statuses: string[] = []
    const client = makeSocket(statuses)
    const pending = client.connect()
    welcome(FakeSocket.instances[0])
    await expect(pending).resolves.toMatchObject({ role: "guest" })
    FakeSocket.instances[0].close()
    await vi.advanceTimersByTimeAsync(2_000)
    const retry = FakeSocket.instances[1]
    retry.emit("open")
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS + 1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(FakeSocket.instances.length).toBeGreaterThan(2)
    expect(statuses.filter((s) => s === "reconnecting").length).toBeGreaterThan(1)
    client.close()
  })
})

describe("in-flight reconnect dedup (T F37, G concurrency)", () => {
  it("reconnectNow during a CONNECTING connect() does not open a second socket", async () => {
    const statuses: string[] = []
    const client = makeSocket(statuses)
    const pending = client.connect()
    client.reconnectNow()
    client.reconnectNow()
    expect(FakeSocket.instances).toHaveLength(1)
    welcome(FakeSocket.instances[0])
    await expect(pending).resolves.toMatchObject({ role: "guest" })
    client.close()
  })

  it("concurrent connect() calls share one socket", async () => {
    const client = makeSocket([])
    const a = client.connect()
    const b = client.connect()
    expect(FakeSocket.instances).toHaveLength(1)
    welcome(FakeSocket.instances[0])
    await expect(a).resolves.toMatchObject({ role: "guest" })
    await expect(b).resolves.toMatchObject({ role: "guest" })
    client.close()
  })

  it("reconnectNow resets the attempt budget", async () => {
    vi.useFakeTimers()
    const client = makeSocket([], { reconnect: { maxAttempts: 1, baseMs: 800, maxMs: 8000 } })
    const pending = client.connect()
    welcome(FakeSocket.instances[0])
    await expect(pending).resolves.toMatchObject({ role: "guest" })
    FakeSocket.instances[0].close()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeSocket.instances).toHaveLength(2) // budget spent
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeSocket.instances).toHaveLength(2) // and stays spent
    client.reconnectNow() // user "Retry now" re-arms it
    expect(FakeSocket.instances).toHaveLength(3)
    client.close()
  })
})

describe("credentials (T MM-01 + G slotToken persistence)", () => {
  it("omits reconnectToken from hello when none is retained", async () => {
    const client = makeSocket([])
    const pending = client.connect()
    const ws = FakeSocket.instances[0]
    ws.emit("open")
    const hello = JSON.parse(ws.sent[0]) as Record<string, unknown>
    expect(hello.type).toBe("hello")
    expect("reconnectToken" in hello).toBe(false)
    client.close()
    await expect(pending).rejects.toThrow("closed")
  })

  it("echoes the matchmaking slotToken in hello when bound", async () => {
    const client = makeSocket([], { slotToken: "slot-tok-123" })
    const pending = client.connect()
    const ws = FakeSocket.instances[0]
    ws.emit("open")
    expect((JSON.parse(ws.sent[0]) as Record<string, unknown>).slotToken).toBe("slot-tok-123")
    client.close()
    await expect(pending).rejects.toThrow("closed")
  })

  it("omits slotToken from hello when none was issued", async () => {
    const client = makeSocket([])
    const pending = client.connect()
    const ws = FakeSocket.instances[0]
    ws.emit("open")
    expect("slotToken" in (JSON.parse(ws.sent[0]) as Record<string, unknown>)).toBe(false)
    client.close()
    await expect(pending).rejects.toThrow("closed")
  })

  it("a late-bound slotToken rides the next hello and persists", async () => {
    const storage = memory()
    const client = makeSocket([], { storage })
    client.setSlotToken("late-token")
    const pending = client.connect()
    const ws = FakeSocket.instances[0]
    ws.emit("open")
    expect((JSON.parse(ws.sent[0]) as Record<string, unknown>).slotToken).toBe("late-token")
    expect(storage.data.get("fuurma:room-slot-token:ABCDEF1234567890")).toBe("late-token")
    client.close()
    await expect(pending).rejects.toThrow("closed")
  })

  it("retains the welcome credential and sends it on reconnect", async () => {
    vi.useFakeTimers()
    const storage = memory()
    const client = makeSocket([], { storage })
    const pending = client.connect()
    const ws = FakeSocket.instances[0]
    ws.emit("open")
    ws.emit("message", {
      data: JSON.stringify({
        opponent: null,
        reconnectToken: "tok-abc-123",
        role: "guest",
        type: "welcome",
      }),
    })
    await expect(pending).resolves.toMatchObject({ role: "guest" })
    expect(storage.data.get("fuurma:room-token:ABCDEF1234567890")).toBe("tok-abc-123")
    ws.close()
    await vi.advanceTimersByTimeAsync(2000)
    expect(FakeSocket.instances).toHaveLength(2)
    const ws2 = FakeSocket.instances[1]
    ws2.emit("open")
    expect((JSON.parse(ws2.sent[0]) as Record<string, unknown>).reconnectToken).toBe("tok-abc-123")
    client.close()
  })

  it("a fresh instance reclaims with the persisted credential", async () => {
    const storage = memory()
    storage.data.set("fuurma:room-token:ABCDEF1234567890", "tok-persisted")
    const client = makeSocket([], { storage })
    const pending = client.connect()
    const ws = FakeSocket.instances[0]
    ws.emit("open")
    expect((JSON.parse(ws.sent[0]) as Record<string, unknown>).reconnectToken).toBe("tok-persisted")
    client.close()
    await expect(pending).rejects.toThrow("closed")
  })

  it("uses the game's storage prefixes when configured (tokens survive the swap)", async () => {
    const storage = memory()
    storage.data.set("tictactoe:room-token:ABCDEF1234567890", "tok-legacy")
    const client = makeSocket([], {
      storage,
      tokenPrefix: "tictactoe:room-token:",
      slotTokenPrefix: "tictactoe:room-slot-token:",
    })
    const pending = client.connect()
    FakeSocket.instances[0].emit("open")
    expect(
      (JSON.parse(FakeSocket.instances[0].sent[0]) as Record<string, unknown>).reconnectToken,
    ).toBe("tok-legacy")
    client.close()
    await expect(pending).rejects.toThrow("closed")
  })

  it("a fresh instance sends the persisted slotToken (refresh after reap)", async () => {
    const storage = memory()
    storage.data.set("fuurma:room-slot-token:ABCDEF1234567890", "slot-persisted")
    const client = makeSocket([], { storage })
    const pending = client.connect()
    FakeSocket.instances[0].emit("open")
    expect((JSON.parse(FakeSocket.instances[0].sent[0]) as Record<string, unknown>).slotToken).toBe(
      "slot-persisted",
    )
    client.close()
    await expect(pending).rejects.toThrow("closed")
  })

  it("a newly issued slotToken overrides the stale persisted one", async () => {
    const storage = memory()
    storage.data.set("fuurma:room-slot-token:ABCDEF1234567890", "slot-stale")
    const client = makeSocket([], { storage, slotToken: "slot-fresh" })
    const pending = client.connect()
    FakeSocket.instances[0].emit("open")
    const hello = JSON.parse(FakeSocket.instances[0].sent[0]) as Record<string, unknown>
    expect(hello.slotToken).toBe("slot-fresh")
    expect(storage.data.get("fuurma:room-slot-token:ABCDEF1234567890")).toBe("slot-fresh")
    client.close()
    await expect(pending).rejects.toThrow("closed")
  })

  it("works without stored credentials when the URL carries no room id", async () => {
    const storage = memory()
    const client = makeSocket([], { storage, wsUrl: "ws://relay.test/noroom" })
    const pending = client.connect()
    const ws = FakeSocket.instances[0]
    ws.emit("open")
    ws.emit("message", {
      data: JSON.stringify({
        opponent: null,
        reconnectToken: "tok-x",
        role: "host",
        type: "welcome",
      }),
    })
    await expect(pending).resolves.toMatchObject({ role: "host" })
    expect(storage.data.size).toBe(0)
    client.close()
  })

  it("survives denied storage on credential read and write", async () => {
    const bad: StorageLike = {
      getItem: () => {
        throw new Error("denied")
      },
      setItem: () => {
        throw new Error("denied")
      },
      removeItem: () => {
        throw new Error("denied")
      },
    }
    const client = makeSocket([], { storage: bad })
    const pending = client.connect()
    const ws = FakeSocket.instances[0]
    ws.emit("open")
    ws.emit("message", {
      data: JSON.stringify({
        opponent: null,
        reconnectToken: "tok-x",
        role: "guest",
        type: "welcome",
      }),
    })
    await expect(pending).resolves.toMatchObject({ role: "guest" })
    client.close()
  })

  it("works with no storage implementation at all", async () => {
    const client = makeSocket([], { storage: null })
    const pending = client.connect()
    const ws = FakeSocket.instances[0]
    ws.emit("open")
    ws.emit("message", {
      data: JSON.stringify({
        opponent: { displayName: "Rival", guestId: "guest:2" },
        reconnectToken: "tok-x",
        role: "host",
        type: "welcome",
      }),
    })
    await expect(pending).resolves.toMatchObject({ role: "host" })
    expect(client.isConnected()).toBe(true)
    client.close()
  })
})

describe("credential forget (report 3.7: discard when the room is over)", () => {
  it("close() forgets the room credentials", async () => {
    const storage = memory()
    storage.data.set("fuurma:room-token:ABCDEF1234567890", "tok-old")
    storage.data.set("fuurma:room-slot-token:ABCDEF1234567890", "slot-old")
    const client = makeSocket([], { storage })
    client.close()
    expect(storage.data.size).toBe(0)
  })

  it("peer-left closed/expired forgets; disconnect keeps for reconnect", async () => {
    const storage = memory()
    const client = makeSocket([], { storage })
    const messages: unknown[] = []
    client.setMessageHandler((m) => messages.push(m))
    const pending = client.connect()
    const ws = FakeSocket.instances[0]
    ws.emit("open")
    ws.emit("message", {
      data: JSON.stringify({
        opponent: null,
        reconnectToken: "tok-x",
        role: "guest",
        type: "welcome",
      }),
    })
    await expect(pending).resolves.toMatchObject({ role: "guest" })
    expect(storage.data.size).toBe(1)
    ws.emit("message", { data: JSON.stringify({ reason: "disconnect", type: "peer-left" }) })
    expect(storage.data.size).toBe(1)
    ws.emit("message", { data: JSON.stringify({ reason: "closed", type: "peer-left" }) })
    expect(storage.data.size).toBe(0)
    client.close()
  })

  it("forget(roomId) drops both keys directly", () => {
    const storage = memory()
    const client = makeSocket([], { storage })
    storage.data.set("fuurma:room-token:R1", "a")
    storage.data.set("fuurma:room-slot-token:R1", "b")
    client.forget("R1")
    expect(storage.data.size).toBe(0)
  })
})

describe("close signatures (G F395: recycle vs departure)", () => {
  it("close() sends the voluntary departure signature", async () => {
    const client = makeSocket([])
    const pending = client.connect()
    welcome(FakeSocket.instances[0])
    await expect(pending).resolves.toMatchObject({ role: "guest" })
    client.close()
    expect(FakeSocket.instances[0].closeFrame).toEqual({ code: 1000, reason: "client closing" })
  })

  it("closeForReconnect() sends the transient recycle signature", async () => {
    const client = makeSocket([])
    const pending = client.connect()
    welcome(FakeSocket.instances[0])
    await expect(pending).resolves.toMatchObject({ role: "guest" })
    client.closeForReconnect()
    expect(FakeSocket.instances[0].closeFrame).toEqual({ code: 4000, reason: "reconnecting" })
    expect(client.getStatus()).toBe("disconnected")
  })
})

describe("welcome validation (T F748)", () => {
  it("rejects a welcome whose role is not a seat", async () => {
    const client = makeSocket([])
    const pending = client.connect()
    const ws = FakeSocket.instances[0]
    ws.emit("open")
    ws.emit("message", {
      data: JSON.stringify({ opponent: null, role: "spectator", type: "welcome" }),
    })
    await expect(pending).rejects.toThrow("malformed welcome")
    client.close()
  })

  it("rejects a welcome whose opponent is not a player profile", async () => {
    const client = makeSocket([])
    const pending = client.connect()
    const ws = FakeSocket.instances[0]
    ws.emit("open")
    ws.emit("message", {
      data: JSON.stringify({ opponent: { displayName: "No id" }, role: "host", type: "welcome" }),
    })
    await expect(pending).rejects.toThrow("malformed welcome")
    client.close()
  })

  it("adopts a welcome that carries a real seat and a real opponent", async () => {
    const client = makeSocket([])
    const pending = client.connect()
    const ws = FakeSocket.instances[0]
    ws.emit("open")
    ws.emit("message", {
      data: JSON.stringify({
        opponent: { displayName: "Rival", guestId: "guest:2" },
        role: "host",
        type: "welcome",
      }),
    })
    await expect(pending).resolves.toMatchObject({
      opponent: { displayName: "Rival", guestId: "guest:2" },
      role: "host",
    })
    client.close()
  })
})

describe("send + routing (no protocol envelope, no caps)", () => {
  it("sends frames verbatim and reports false when the socket is down", async () => {
    const client = makeSocket([])
    expect(client.send({ type: "leave" })).toBe(false)
    const pending = client.connect()
    welcome(FakeSocket.instances[0])
    await expect(pending).resolves.toMatchObject({ role: "guest" })
    expect(client.send({ type: "leave" })).toBe(true)
    expect(FakeSocket.instances[0].sent.at(-1)).toBe(JSON.stringify({ type: "leave" }))
    client.close()
  })

  it("returns cached session when already connected", async () => {
    const client = makeSocket([])
    const pending = client.connect()
    welcome(FakeSocket.instances[0])
    await expect(pending).resolves.toMatchObject({ role: "guest" })
    await expect(client.connect()).resolves.toMatchObject({ role: "guest" })
    expect(FakeSocket.instances).toHaveLength(1)
    client.close()
  })

  it("forwards non-welcome frames and hands welcome to the handler too", async () => {
    const client = makeSocket([])
    const seen: unknown[] = []
    client.setMessageHandler((m) => seen.push(m))
    const pending = client.connect()
    const ws = FakeSocket.instances[0]
    ws.emit("open")
    ws.emit("message", { data: JSON.stringify({ move: 4, type: "move" }) })
    ws.emit("message", {
      data: JSON.stringify({ opponent: null, role: "guest", type: "welcome" }),
    })
    await expect(pending).resolves.toMatchObject({ role: "guest" })
    expect(seen).toHaveLength(2)
    client.close()
  })

  it("ignores malformed JSON frames", async () => {
    const client = makeSocket([])
    const seen: unknown[] = []
    client.setMessageHandler((m) => seen.push(m))
    const pending = client.connect()
    const ws = FakeSocket.instances[0]
    ws.emit("open")
    ws.emit("message", { data: "not json{{{" })
    ws.emit("message", { data: JSON.stringify({ opponent: null, role: "guest", type: "welcome" }) })
    await expect(pending).resolves.toMatchObject({ role: "guest" })
    expect(seen).toHaveLength(1)
    client.close()
  })

  it("reports connected only with status connected and an open socket", async () => {
    const client = makeSocket([])
    expect(client.isConnected()).toBe(false)
    const pending = client.connect()
    welcome(FakeSocket.instances[0])
    await expect(pending).resolves.toMatchObject({ role: "guest" })
    expect(client.isConnected()).toBe(true)
    client.close()
    expect(client.isConnected()).toBe(false)
  })
})
