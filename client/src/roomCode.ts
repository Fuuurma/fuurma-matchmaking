/**
 * Room codes and invite links.
 *
 * Server rule (M utils.ts): a room id is `^[A-Za-z0-9_-]{4,64}$` and the DO
 * is keyed by the exact string — no case folding on the wire. Generated
 * codes use Gambit's unambiguous alphabet; custom codes (T's `friday-game`)
 * pass through untouched. All helpers take plain strings so no DOM type
 * ever enters the SDK: callers pass `location.search` / `location.href`
 * and a `history.replaceState` callback.
 */

/** The server's room-id rule. */
export const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/

/** Unambiguous alphabet: no 0/O, 1/I/L, matching Gambit's generator. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

export const DEFAULT_CODE_LENGTH = 6

type RandomWord = (count: number) => number

function defaultRandomWord(count: number): number {
  const g = globalThis as unknown as {
    crypto?: { getRandomValues(arr: Uint32Array): void }
  }
  const crypto = g.crypto
  if (!crypto) throw new Error("generateRoomCode: no secure RNG available")
  const buf = new Uint32Array(1)
  // Rejection-sample so the modulo does not bias short alphabets.
  const limit = Math.floor(0x100000000 / count) * count
  for (;;) {
    crypto.getRandomValues(buf)
    if (buf[0] < limit) return buf[0] % count
  }
}

/** CSPRNG code of `length` chars from the unambiguous alphabet. */
export function generateRoomCode(
  length = DEFAULT_CODE_LENGTH,
  rand: RandomWord = defaultRandomWord,
): string {
  let out = ""
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[rand(CODE_ALPHABET.length)]
  return out
}

export interface NormalizeOptions {
  /** Uppercase before validating (Gambit-style 6-char codes). Default false. */
  upper?: boolean
}

/** Trim (and optionally uppercase); "" when the result is not a room id. */
export function normalizeRoomCode(raw: string | null | undefined, opts?: NormalizeOptions): string {
  let code = raw?.trim() ?? ""
  if (opts?.upper === true) code = code.toUpperCase()
  return ROOM_ID_PATTERN.test(code) ? code : ""
}

/** `${base}?room=${code}`; `base` is the game's own root or lobby path. */
export function buildInviteLink(code: string, base: string): string {
  const url = new URL(base)
  url.searchParams.set("room", code)
  return url.toString()
}

/** Read `?room=` from a query string (`location.search`); null when absent/invalid. */
export function readRoomCodeFromUrl(search: string | null | undefined): string | null {
  if (!search) return null
  const params = new URLSearchParams(search.startsWith("?") ? search : `?${search}`)
  const code = params.get("room")?.trim() ?? ""
  if (!code || !ROOM_ID_PATTERN.test(code)) return null
  return code
}

/**
 * Drop `?room=` from `href`, preserving every other param and the hash
 * (Gambit's clearRoomFromUrl; T's version wiped them). Calls `replace`
 * with the next path+query+hash only when a room param is present.
 */
export function clearRoomCodeFromUrl(href: string, replace: (next: string) => void): void {
  const url = new URL(href)
  if (!url.searchParams.has("room")) return
  url.searchParams.delete("room")
  replace(`${url.pathname}${url.search}${url.hash}`)
}

export interface LastRoom {
  roomId: string
  role: "host" | "guest"
}

/** False for a missing/invalid code, or the host re-opening their own link. */
export function shouldAutoJoinInvite(code: string | null, lastRoom: LastRoom | null): boolean {
  if (!code || !ROOM_ID_PATTERN.test(code)) return false
  if (lastRoom?.role === "host" && lastRoom.roomId === code) return false
  return true
}
