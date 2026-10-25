import { describe, expect, it, vi } from "vitest"
import {
  createIdentity,
  filterDisplayNameInput,
  resolveNameCollision,
  sanitizeDisplayName,
} from "../../src/identity"

describe("sanitizeDisplayName (superset of T + G + server rules)", () => {
  it("keeps ordinary names untouched", () => {
    expect(sanitizeDisplayName("Rival")).toBe("Rival")
    expect(sanitizeDisplayName("Crimson Fox")).toBe("Crimson Fox")
  })

  it("falls back when empty or too short (server: min 2, 'Guest')", () => {
    expect(sanitizeDisplayName("")).toBe("Guest")
    expect(sanitizeDisplayName("A")).toBe("Guest")
    expect(sanitizeDisplayName(null)).toBe("Guest")
    expect(sanitizeDisplayName("  ")).toBe("Guest")
  })

  it("honours a caller fallback (per-game random names)", () => {
    expect(sanitizeDisplayName("", "Crimson Fox")).toBe("Crimson Fox")
  })

  it("strips HTML-special chars like the server (<>\"'`)", () => {
    expect(sanitizeDisplayName("O'Brien")).toBe("OBrien")
    expect(sanitizeDisplayName("<b>hi</b>")).toBe("bhi/b")
  })

  it("strips invisible padding before the length check (T F121)", () => {
    // A name of only zero-widths must not pass min-length on unseen chars.
    expect(sanitizeDisplayName("​".repeat(5))).toBe("Guest")
    expect(sanitizeDisplayName("­ab")).toBe("ab")
  })

  it("normalises compatibility characters (G NFKC)", () => {
    expect(sanitizeDisplayName("ﬁ")).toBe("fi")
  })

  it("collapses inner whitespace and trims (T)", () => {
    expect(sanitizeDisplayName("  a   b  ")).toBe("a b")
  })

  it("caps at 20 UTF-16 units without splitting a surrogate pair (T F469)", () => {
    const pair = "😀"
    const long = `abcdefghijklmnopqrst${pair}`
    const out = sanitizeDisplayName(long)
    expect(out.length).toBeLessThanOrEqual(20)
    expect(out).toBe("abcdefghijklmnopqrst")
    // A pair that does not fit is dropped whole, never halved.
    expect(sanitizeDisplayName(`abcdefghijklmnopqrs${pair}`).length).toBeLessThanOrEqual(20)
    for (const ch of sanitizeDisplayName(`abcdefghijklmnopqrs${pair}`)) {
      expect(ch.codePointAt(0)).not.toBe(0xfffd)
    }
  })

  it("drops control characters", () => {
    expect(sanitizeDisplayName("ab")).toBe("ab")
  })
})

describe("filterDisplayNameInput (live-typing filter: no trim, no fallback)", () => {
  it("strips illegal chars but keeps partial input intact", () => {
    expect(filterDisplayNameInput("")).toBe("")
    expect(filterDisplayNameInput("A")).toBe("A")
    expect(filterDisplayNameInput("a ")).toBe("a ")
    expect(filterDisplayNameInput("a<b")).toBe("ab")
  })

  it("caps at 20 units", () => {
    expect(filterDisplayNameInput("a".repeat(25))).toBe("a".repeat(20))
  })
})

describe("resolveNameCollision (G rename)", () => {
  it("leaves distinct names alone", () => {
    expect(resolveNameCollision("Rival", "Host")).toBe("Rival")
  })

  it("appends ' 2' within the 20-unit cap", () => {
    expect(resolveNameCollision("Rival", "Rival")).toBe("Rival 2")
    expect(resolveNameCollision("a".repeat(20), "a".repeat(20))).toBe(`${"a".repeat(18)} 2`)
  })
})

describe("createIdentity (per-game storage namespace, injected storage)", () => {
  function memory() {
    const store = new Map<string, string>()
    return {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      data: store,
    }
  }

  it("creates and persists a guest identity under the game's keys", () => {
    const storage = memory()
    const id = createIdentity({
      storageKeys: { guestId: "tictactoe:guestId", displayName: "tictactoe:displayName" },
      randomName: () => "Crimson Fox",
      storage,
    })
    expect(id.guestId()).toMatch(/^guest:/)
    expect(id.displayName()).toBe("Crimson Fox")
    expect(storage.data.get("tictactoe:guestId")).toBe(id.guestId())
  })

  it("reuses the stored identity on the next instance", () => {
    const storage = memory()
    const first = createIdentity({
      storageKeys: { guestId: "g:id", displayName: "g:name" },
      randomName: () => "Crimson Fox",
      storage,
    })
    const second = createIdentity({
      storageKeys: { guestId: "g:id", displayName: "g:name" },
      randomName: () => "Other Name",
      storage,
    })
    expect(second.guestId()).toBe(first.guestId())
    expect(second.displayName()).toBe(first.displayName())
  })

  it("setDisplayName sanitizes, persists, and returns the stored value", () => {
    const storage = memory()
    const id = createIdentity({
      storageKeys: { guestId: "g:id", displayName: "g:name" },
      randomName: () => "Crimson Fox",
      storage,
    })
    expect(id.setDisplayName("  <Rival>  ")).toBe("Rival")
    expect(id.displayName()).toBe("Rival")
    // An unsanitary save keeps the previous good name (T saveDisplayName).
    expect(id.setDisplayName("")).toBe("Rival")
  })

  it("works with null storage (memory-only identity)", () => {
    const id = createIdentity({
      storageKeys: { guestId: "g:id", displayName: "g:name" },
      randomName: () => "Crimson Fox",
      storage: null,
    })
    expect(id.guestId()).toMatch(/^guest:/)
    expect(id.setDisplayName("Rival")).toBe("Rival")
  })

  it("survives denied storage on read and write", () => {
    const bad = {
      getItem: (_k: string): string | null => {
        throw new Error("denied")
      },
      setItem: (_k: string, _v: string): void => {
        throw new Error("denied")
      },
      removeItem: (_k: string): void => {
        throw new Error("denied")
      },
    }
    const id = createIdentity({
      storageKeys: { guestId: "g:id", displayName: "g:name" },
      randomName: () => "Crimson Fox",
      storage: bad,
    })
    expect(id.guestId()).toMatch(/^guest:/)
    expect(id.setDisplayName("Rival")).toBe("Rival")
  })

  it("generates fallback ids without crypto when needed", () => {
    vi.stubGlobal("crypto", undefined)
    try {
      const id = createIdentity({
        storageKeys: { guestId: "g:id", displayName: "g:name" },
        randomName: () => "Crimson Fox",
        storage: null,
      })
      expect(id.guestId()).toMatch(/^guest:/)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
