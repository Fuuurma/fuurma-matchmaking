import { describe, expect, it } from "vitest"
import {
  buildInviteLink,
  clearRoomCodeFromUrl,
  generateRoomCode,
  normalizeRoomCode,
  ROOM_ID_PATTERN,
  readRoomCodeFromUrl,
  shouldAutoJoinInvite,
} from "../../src/roomCode"

describe("ROOM_ID_PATTERN (server rule: 4-64 of A-Za-z0-9_-)", () => {
  it("accepts UUIDs, custom codes, and 6-char generated codes", () => {
    expect(ROOM_ID_PATTERN.test("friday-game")).toBe(true)
    expect(ROOM_ID_PATTERN.test("ABC123")).toBe(true)
    expect(ROOM_ID_PATTERN.test("123e4567-e89b-12d3-a456-426614174000")).toBe(true)
  })

  it("rejects short, empty, and special-char values", () => {
    expect(ROOM_ID_PATTERN.test("abc")).toBe(false)
    expect(ROOM_ID_PATTERN.test("")).toBe(false)
    expect(ROOM_ID_PATTERN.test("O'Brien")).toBe(false)
    expect(ROOM_ID_PATTERN.test("a b")).toBe(false)
  })
})

describe("generateRoomCode", () => {
  it("defaults to 6 unambiguous chars", () => {
    const code = generateRoomCode()
    expect(code).toHaveLength(6)
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/)
  })

  it("honours a length param and uses the injected RNG", () => {
    const code = generateRoomCode(4, () => 0)
    expect(code).toBe("AAAA")
  })

  it("two default codes differ", () => {
    expect(generateRoomCode()).not.toBe(generateRoomCode())
  })
})

describe("normalizeRoomCode", () => {
  it("trims and keeps valid codes as-is (server keys are exact-match)", () => {
    expect(normalizeRoomCode("  ABC123  ")).toBe("ABC123")
    expect(normalizeRoomCode("friday-game")).toBe("friday-game")
  })

  it("returns empty for invalid input", () => {
    expect(normalizeRoomCode(null)).toBe("")
    expect(normalizeRoomCode(undefined)).toBe("")
    expect(normalizeRoomCode("ab")).toBe("")
    expect(normalizeRoomCode("a b")).toBe("")
  })

  it("folds case only when asked (Gambit-style links)", () => {
    expect(normalizeRoomCode("abc123", { upper: true })).toBe("ABC123")
  })
})

describe("invite links (no window: strings in, strings out)", () => {
  it("builds a link carrying ?room=", () => {
    const link = buildInviteLink("ABC123", "https://game.example/play")
    expect(link).toContain("room=ABC123")
    expect(link.startsWith("https://game.example/")).toBe(true)
  })

  it("reads a valid code from a query string", () => {
    expect(readRoomCodeFromUrl("?room=ABC123")).toBe("ABC123")
    expect(readRoomCodeFromUrl("?foo=1&room=abc-123")).toBe("abc-123")
  })

  it("rejects missing or invalid codes", () => {
    expect(readRoomCodeFromUrl("?foo=1")).toBeNull()
    expect(readRoomCodeFromUrl("?room=ab")).toBeNull()
    expect(readRoomCodeFromUrl(null)).toBeNull()
  })

  it("clears only the room param, preserving the rest", () => {
    let replaced = ""
    clearRoomCodeFromUrl("https://g.example/play?room=ABC123&tab=online#top", (n) => {
      replaced = n
    })
    expect(replaced).toBe("/play?tab=online#top")
  })

  it("leaves the URL alone when no room param is present", () => {
    let called = false
    clearRoomCodeFromUrl("https://g.example/play?tab=online", () => {
      called = true
    })
    expect(called).toBe(false)
  })

  it("shouldAutoJoinInvite skips the host's own link", () => {
    expect(shouldAutoJoinInvite("ABC123", null)).toBe(true)
    expect(shouldAutoJoinInvite("ABC123", { roomId: "ABC123", role: "host" })).toBe(false)
    expect(shouldAutoJoinInvite("ABC123", { roomId: "ABC123", role: "guest" })).toBe(true)
    expect(shouldAutoJoinInvite(null, null)).toBe(false)
    expect(shouldAutoJoinInvite("ab", null)).toBe(false)
  })
})
