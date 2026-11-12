import { describe, expect, it } from "vitest"
import { SECURITY_HEADERS, secretsMatch, withSecurityHeaders } from "./utils"

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

describe("withSecurityHeaders", () => {
  it("adds the missing security set and preserves status and body", async () => {
    // DO passthrough responses carry immutable headers, so the edge rebuilds.
    const res = withSecurityHeaders(new Response("hello", { status: 201 }))
    expect(res.status).toBe(201)
    expect(await res.text()).toBe("hello")
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(res.headers.get(name)).toBe(value)
    }
  })

  it("returns a response that already carries the set untouched", () => {
    const original = new Response("hi", { headers: SECURITY_HEADERS })
    expect(withSecurityHeaders(original)).toBe(original)
  })

  it("passes WebSocket upgrades through untouched", () => {
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    server.accept()
    const res = new Response(null, { status: 101, webSocket: client })
    expect(withSecurityHeaders(res)).toBe(res)
    client.accept()
    client.close()
    server.close()
  })
})
