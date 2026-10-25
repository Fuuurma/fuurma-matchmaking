import { afterEach, describe, expect, it, vi } from "vitest"
import type { Health } from "../../src/matchmaking"
import { createPresence } from "../../src/presence"

const HEALTH: Health = { waiting: 3, matches: 2, players: 7 }

afterEach(() => {
  vi.useRealTimers()
})

describe("createPresence", () => {
  it("stays null until the first successful read (never a fake 0)", async () => {
    const presence = createPresence({ load: async () => HEALTH })
    expect(presence.getSnapshot()).toBeNull()
    await presence.refresh()
    expect(presence.getSnapshot()).toEqual(HEALTH)
    presence.stop()
  })

  it("notifies subscribers on change only", async () => {
    let health = HEALTH
    const presence = createPresence({ load: async () => health })
    let calls = 0
    const unsub = presence.subscribe(() => {
      calls += 1
    })
    await presence.refresh()
    expect(calls).toBe(1)
    await presence.refresh() // same reference: no notify
    expect(calls).toBe(1)
    health = { waiting: 4, matches: 2, players: 8 }
    await presence.refresh()
    expect(calls).toBe(2)
    unsub()
    presence.stop()
  })

  it("keeps the last good number across a failed refresh", async () => {
    let fail = false
    const presence = createPresence({
      load: async () => {
        if (fail) throw new Error("down")
        return HEALTH
      },
    })
    await presence.refresh()
    fail = true
    await presence.refresh()
    expect(presence.getSnapshot()).toEqual(HEALTH)
    presence.stop()
  })

  it("polls on a cadence and backs off after failures", async () => {
    vi.useFakeTimers()
    let calls = 0
    let fail = false
    const presence = createPresence({
      load: async () => {
        calls += 1
        if (fail) throw new Error("down")
        return HEALTH
      },
      pollMs: 15_000,
      errorBackoffMs: 30_000,
    })
    presence.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(calls).toBe(2)
    fail = true
    await vi.advanceTimersByTimeAsync(15_000)
    expect(calls).toBe(3)
    // Backoff: 15 s later no new call; 30 s later there is one.
    await vi.advanceTimersByTimeAsync(15_000)
    expect(calls).toBe(3)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(calls).toBe(4)
    presence.stop()
  })

  it("pauses while inactive and catches up after", async () => {
    vi.useFakeTimers()
    let calls = 0
    let active = false
    const presence = createPresence({
      load: async () => {
        calls += 1
        return HEALTH
      },
      isActive: () => active,
      pollMs: 5_000,
    })
    presence.start()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(calls).toBe(0)
    active = true
    await vi.advanceTimersByTimeAsync(5_000)
    expect(calls).toBeGreaterThan(0)
    presence.stop()
  })

  it("start is idempotent and stop halts polling", async () => {
    vi.useFakeTimers()
    let calls = 0
    const presence = createPresence({
      load: async () => {
        calls += 1
        return HEALTH
      },
      pollMs: 5_000,
    })
    presence.start()
    presence.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)
    presence.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toBe(1)
  })
})
