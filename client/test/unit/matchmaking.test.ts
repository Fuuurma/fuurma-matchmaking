import { afterEach, describe, expect, it, vi } from "vitest"
import { FuurmaError } from "../../src/errors"
import {
  buildRoomWsUrl,
  getMatchPollDelay,
  isConfigured,
  type LeaveOptions,
  MATCHMAKING_UNAVAILABLE_MESSAGE,
  MatchmakingClient,
  parseHealthBody,
  parseMatchmakingResponse,
  releaseOnPageHide,
} from "../../src/matchmaking"

interface MockResponse {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
  json(): Promise<unknown>
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = { "content-type": "application/json" },
): MockResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
  }
}

function errorResponse(error: string, status: number, retryAfterSec?: number): MockResponse {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (retryAfterSec !== undefined) headers["retry-after"] = String(retryAfterSec)
  return jsonResponse({ error }, status, headers)
}

function clientFor(
  impl: (url: string, init?: RequestInit) => Promise<MockResponse>,
  opts?: { baseUrl?: string; game?: string },
): { client: MatchmakingClient; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return impl(url, init)
  }) as unknown as typeof fetch
  const client = new MatchmakingClient({
    baseUrl: opts?.baseUrl ?? "https://mm.example",
    fetchFn,
    game: opts?.game ?? "tictactoe",
  })
  return { client, calls }
}

const WAITING = { status: "waiting", ticket: "tick-1", roomId: "ROOM01" }
const MATCHED = {
  status: "matched",
  match: {
    roomId: "ROOM99",
    role: "guest",
    host: { peerId: "p1", displayName: "Host", guestId: "guest:h" },
    guest: { peerId: "p2", displayName: "Guest", guestId: "guest:g" },
  },
  slotToken: "slot-1",
}

afterEach(() => {
  vi.useRealTimers()
})

describe("getMatchPollDelay (1 s doubling to a 4 s cap)", () => {
  it("starts short and caps", () => {
    expect(getMatchPollDelay(0)).toBe(1_000)
    expect(getMatchPollDelay(1)).toBe(2_000)
    expect(getMatchPollDelay(2)).toBe(4_000)
    expect(getMatchPollDelay(10)).toBe(4_000)
  })

  it("uses the initial delay for invalid attempts", () => {
    expect(getMatchPollDelay(-1)).toBe(1_000)
    expect(getMatchPollDelay(Number.NaN)).toBe(1_000)
  })
})

describe("parseMatchmakingResponse", () => {
  it("accepts well-formed waiting and matched responses", () => {
    expect(parseMatchmakingResponse(WAITING)).toEqual(WAITING)
    expect(parseMatchmakingResponse(MATCHED)).toEqual(MATCHED)
  })

  it("takes role/roomId from the poll result (guest path, T 3.2)", () => {
    const parsed = parseMatchmakingResponse(MATCHED)
    if (parsed.status !== "matched") throw new Error("expected matched")
    expect(parsed.match.role).toBe("guest")
    expect(parsed.match.roomId).toBe("ROOM99")
    expect(parsed.slotToken).toBe("slot-1")
  })

  it("ignores fields the Worker contract does not define", () => {
    expect(parseMatchmakingResponse({ ...WAITING, position: 3 })).toEqual(WAITING)
  })

  it("rejects malformed bodies instead of casting them through", () => {
    for (const bad of [null, 42, {}, { status: "waiting" }, { status: "matched", match: {} }]) {
      expect(() => parseMatchmakingResponse(bad)).toThrow(FuurmaError)
    }
  })
})

describe("parseHealthBody", () => {
  it("accepts a well-formed health body and an empty queue", () => {
    expect(parseHealthBody({ ok: true, game: "tictactoe", waiting: 3, matches: 2 })).toEqual({
      waiting: 3,
      matches: 2,
    })
    expect(parseHealthBody({ ok: true, game: "tictactoe", waiting: 0, matches: 0 })).toEqual({
      waiting: 0,
      matches: 0,
    })
  })

  it("rejects non-reports and non-whole counts", () => {
    for (const bad of [
      null,
      { ok: false, game: "t", waiting: 1, matches: 0 },
      { ok: true, game: "t", waiting: -1, matches: 0 },
      { ok: true, game: "t", waiting: 1.5, matches: 0 },
      { ok: true, game: "t", waiting: "3", matches: 0 },
    ]) {
      expect(parseHealthBody(bad)).toBeNull()
    }
  })
})

describe("MatchmakingClient construction", () => {
  it("refuses an empty base URL instead of dialling localhost (T 3.8)", () => {
    expect(() => new MatchmakingClient({ baseUrl: "", game: "tictactoe" })).toThrow(
      MATCHMAKING_UNAVAILABLE_MESSAGE,
    )
    expect(isConfigured("")).toBe(false)
    expect(isConfigured("https://mm.example")).toBe(true)
  })
})

describe("join / poll / leave / health", () => {
  it("posts the identity body to /join", async () => {
    const { client, calls } = clientFor(async () => jsonResponse(WAITING))
    await client.join({ peerId: "p", displayName: "Rival", guestId: "guest:1" })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("https://mm.example/api/matchmaking/tictactoe/join")
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      peerId: "p",
      displayName: "Rival",
      guestId: "guest:1",
    })
  })

  it("polls by ticket and leaves by ticket", async () => {
    const { client, calls } = clientFor(async () => jsonResponse(WAITING))
    await client.poll("tick-1")
    expect(calls[0].url).toContain("/poll?ticket=tick-1")
    await client.leave("tick-1")
    expect(calls[1].url.endsWith("/leave")).toBe(true)
    expect(JSON.parse(calls[1].init?.body as string)).toEqual({ ticket: "tick-1" })
  })

  it("passes keepalive through on leave (pagehide path)", async () => {
    const { client, calls } = clientFor(async () => jsonResponse({}))
    await client.leave("tick-1", { keepalive: true })
    expect((calls[0].init as RequestInit & { keepalive?: boolean }).keepalive).toBe(true)
  })

  it("health returns counts plus players, never a fake 0", async () => {
    const { client } = clientFor(async () =>
      jsonResponse({ ok: true, game: "tictactoe", waiting: 3, matches: 2 }),
    )
    await expect(client.health()).resolves.toEqual({ waiting: 3, matches: 2, players: 7 })
  })

  it("health throws on malformed bodies", async () => {
    const { client } = clientFor(async () => jsonResponse({ ok: true }))
    await expect(client.health()).rejects.toThrow(FuurmaError)
  })
})

describe("failure mapping (report 3.5: parse {error}, honour Retry-After)", () => {
  it("parses the {error} body instead of surfacing raw JSON", async () => {
    const { client } = clientFor(async () => errorResponse("too many join attempts", 429, 30))
    const err = await client.join({ peerId: "p", displayName: "R", guestId: "g" }).then(
      () => null,
      (e: unknown) => e as FuurmaError,
    )
    expect(err).toBeInstanceOf(FuurmaError)
    expect(err?.code).toBe("rate-limited")
    expect(err?.message).toContain("Too many join attempts")
    expect(err?.message).toContain("30s")
    expect(err?.retryAfterSec).toBe(30)
    expect(err?.terminal).toBe(false)
  })

  it("maps 503 to unavailable and 404 polls to ticket-expired", async () => {
    const gone = clientFor(async () => errorResponse("ticket expired", 410))
    await expect(gone.client.poll("t")).rejects.toMatchObject({ code: "ticket-expired" })
    const down = clientFor(async () => errorResponse("server error", 500))
    await expect(down.client.health()).rejects.toMatchObject({
      code: "unavailable",
      terminal: false,
    })
  })

  it("rejects non-JSON success bodies (SPA-fallback masquerade)", async () => {
    const { client } = clientFor(async () =>
      jsonResponse("<html>", 200, { "content-type": "text/html" }),
    )
    await expect(client.health()).rejects.toMatchObject({ code: "protocol" })
  })

  it("a hung request times out as transient unavailable", async () => {
    vi.useFakeTimers()
    const { client } = clientFor(
      (_url, init) =>
        new Promise<MockResponse>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"))
          })
        }),
      {},
    )
    const pending = client.health()
    const assertion = expect(pending).rejects.toMatchObject({
      code: "unavailable",
      terminal: false,
    })
    await vi.advanceTimersByTimeAsync(10_001)
    await assertion
  })

  it("caller abort cancels silently with code cancelled", async () => {
    const { client, calls } = clientFor(async () => jsonResponse(WAITING))
    const controller = new AbortController()
    controller.abort()
    await expect(client.poll("t", { signal: controller.signal })).rejects.toMatchObject({
      code: "cancelled",
    })
    expect(calls).toHaveLength(0)
  })
})

describe("waitForMatch", () => {
  it("returns the guest claim from the poll result", async () => {
    let polls = 0
    const { client } = clientFor(async () => {
      polls += 1
      return jsonResponse(polls < 3 ? WAITING : MATCHED)
    })
    const sleeps: number[] = []
    const claim = await client.waitForMatch("tick-1", { sleep: async (ms) => void sleeps.push(ms) })
    expect(claim).toEqual({ roomId: "ROOM99", role: "guest", slotToken: "slot-1" })
    expect(sleeps).toEqual([1_000, 2_000]) // 1 s doubling to the 4 s cap
  })

  it("tolerates blips but ends the search on refusals", async () => {
    const transient = clientFor(async () => errorResponse("server error", 503))
    const sleeps: number[] = []
    await expect(
      transient.client.waitForMatch("t", {
        maxConsecutiveFailures: 2,
        sleep: async (ms) => void sleeps.push(ms),
      }),
    ).rejects.toMatchObject({ code: "unavailable" })
    expect(sleeps).toHaveLength(1) // one blip survived, the second ended it
  })

  it("honours Retry-After by waiting at least that long", async () => {
    const { client } = clientFor(async () => errorResponse("slow down", 429, 25))
    const sleeps: number[] = []
    await expect(
      client.waitForMatch("t", {
        maxConsecutiveFailures: 1,
        sleep: async (ms) => void sleeps.push(ms),
      }),
    ).rejects.toMatchObject({ code: "rate-limited" })
    // Single failure with budget 1 ends the search; Retry-After path needs
    // budget: with 2 it waits max(1 s backoff, 25 s).
    expect(sleeps).toHaveLength(0)
    const { client: c2 } = clientFor(async () => errorResponse("slow down", 429, 25))
    const waits: number[] = []
    await expect(
      c2.waitForMatch("t", { maxConsecutiveFailures: 2, sleep: async (ms) => void waits.push(ms) }),
    ).rejects.toMatchObject({ code: "rate-limited" })
    expect(waits[0]).toBe(25_000)
  })

  it("ends the search at the wait cap", async () => {
    const { client } = clientFor(async () => jsonResponse(WAITING))
    await expect(
      client.waitForMatch("t", { maxWaitMs: 1_500, sleep: async () => {} }),
    ).rejects.toMatchObject({ code: "peer-never-arrived" })
  })

  it("caller cancel ends the search as cancelled", async () => {
    const { client } = clientFor(async () => jsonResponse(WAITING))
    const controller = new AbortController()
    const pending = client.waitForMatch("t", {
      signal: controller.signal,
      sleep: async () => void controller.abort(),
    })
    await expect(pending).rejects.toMatchObject({ code: "cancelled" })
  })
})

describe("releaseOnPageHide", () => {
  it("leaves with keepalive when the page dies", async () => {
    const left: Array<{ ticket: string; keepalive?: boolean }> = []
    const sub = (fire: () => void): (() => void) => {
      fire()
      return () => {}
    }
    const unsub = releaseOnPageHide(
      "tick-1",
      {
        leave: async (ticket: string, opts?: LeaveOptions) =>
          void left.push({ ticket, keepalive: opts?.keepalive }),
      },
      sub,
    )
    expect(left).toEqual([{ ticket: "tick-1", keepalive: true }])
    expect(typeof unsub).toBe("function")
  })
})

describe("buildRoomWsUrl", () => {
  it("maps the origin to the relay URL with ws(s) scheme", () => {
    expect(buildRoomWsUrl("ROOM01", "https://mm.example")).toBe("wss://mm.example/room/ROOM01")
    expect(buildRoomWsUrl("ROOM01", "http://127.0.0.1:8787")).toBe(
      "ws://127.0.0.1:8787/room/ROOM01",
    )
  })

  it("refuses an empty base instead of dialling localhost", () => {
    expect(() => buildRoomWsUrl("ROOM01", "")).toThrow(MATCHMAKING_UNAVAILABLE_MESSAGE)
  })
})
