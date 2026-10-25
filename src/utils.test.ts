import { describe, expect, it } from "vitest"
import { secretsMatch } from "./utils"

describe("secretsMatch", () => {
  it("is true only for identical strings", () => {
    const token = "0123456789abcdef0123456789abcdef"
    expect(secretsMatch(token, token)).toBe(true)
    expect(secretsMatch(token, `${token.slice(0, 31)}0`)).toBe(false)
    expect(secretsMatch(token, token.slice(0, 31))).toBe(false)
    expect(secretsMatch("", "")).toBe(true)
    expect(secretsMatch("é", "e")).toBe(false)
  })
})
