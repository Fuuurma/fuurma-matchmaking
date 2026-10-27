/**
 * Guest identity: stable guestId + sanitized display name under the game's
 * own storage keys (never migrated — changing a key silently drops
 * reconnect tokens for in-flight rooms).
 *
 * `sanitizeDisplayName` is the superset of the three rules that used to
 * disagree (server M utils.ts, T identity.ts, G guestIdentity.ts): a name
 * like `O'Brien` no longer flickers between channels.
 * Word lists stay per game: callers inject `randomName`.
 */

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface IdentityConfig {
  storageKeys: { guestId: string; displayName: string }
  randomName: () => string
  storage?: StorageLike | null
}

export interface Identity {
  guestId(): string
  displayName(): string
  /** Sanitize + persist; returns the stored value. */
  setDisplayName(raw: string): string
}

const DISPLAY_NAME_MIN_LENGTH = 2
const DISPLAY_NAME_MAX_LENGTH = 20

/**
 * T's closed invisible set (F121): Unicode `Default_Ignorable_Code_Point`
 * minus the glyph-modifier families (variation selectors, tag chars, Khmer
 * vowels) that would corrupt real names if stripped. A superset of G's
 * invisible + RTL lists. Re-derive mechanically if a Unicode release adds
 * a default-ignorable character; T's identity.test.ts pins the derivation.
 */
/**
 * Numeric ranges so no invisible literal ever sits in source. Singles and
 * closed ranges of T's F121 set (see the derivation note above).
 */
const INVISIBLE_RANGES: Array<readonly [number, number]> = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x180e, 0x180f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfff8],
]

function isInvisible(codePoint: number): boolean {
  for (const [lo, hi] of INVISIBLE_RANGES) {
    if (codePoint >= lo && codePoint <= hi) return true
  }
  return false
}

function isAllowedCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0
  // Server also strips <>"'`; T stripped only <>. Superset strips all five.
  return (
    codePoint > 31 &&
    codePoint !== 127 &&
    character !== "<" &&
    character !== ">" &&
    character !== '"' &&
    character !== "'" &&
    character !== "`"
  )
}

/** Strip what is never legal, then what is invisible — before any length work. */
function stripDisallowedCharacters(value: string): string {
  let out = ""
  for (const ch of value) {
    if (!isAllowedCharacter(ch)) continue
    if (isInvisible(ch.codePointAt(0) ?? 0)) continue
    out += ch
  }
  return out
}

/**
 * T F469: the cap is a UTF-16 unit budget (the wire counts `.length`
 * units), but the cut lands on a code-point boundary so an astral pair
 * that does not fit is dropped whole instead of emitting a lone surrogate.
 */
function truncateToUtf16Length(value: string, maxUnits: number): string {
  let units = 0
  let end = 0
  for (const character of value) {
    if (units + character.length > maxUnits) break
    units += character.length
    end += character.length
  }
  return value.slice(0, end)
}

/**
 * The single gate every display-name string passes through. G's NFKC
 * normalisation runs first so compatibility characters (ﬁ → fi) fold
 * before filtering; the server's HTML-special strip, T's invisible strip
 * and whitespace collapse follow.
 */
export function sanitizeDisplayName(raw: string | null | undefined, fallback = "Guest"): string {
  const normalized = (raw ?? "").normalize("NFKC")
  const safeValue = stripDisallowedCharacters(normalized)
  const collapsed = truncateToUtf16Length(
    safeValue.replace(/\s+/g, " ").trim(),
    DISPLAY_NAME_MAX_LENGTH,
  )
  return collapsed.length >= DISPLAY_NAME_MIN_LENGTH ? collapsed : fallback
}

/**
 * Per-keystroke filter for name inputs: strips only never-legal chars,
 * deliberately without trim, space-collapse, or fallback — those made
 * clearing the field snap back to a random name (T needs-work 2026-09-10).
 */
export function filterDisplayNameInput(value: string): string {
  return truncateToUtf16Length(
    stripDisallowedCharacters(value.normalize("NFKC")),
    DISPLAY_NAME_MAX_LENGTH,
  )
}

/** G's guest-side rename when both players chose the same name. */
export function resolveNameCollision(myName: string, opponentName: string): string {
  if (myName !== opponentName) return myName
  const suffix = " 2"
  return `${myName.slice(0, DISPLAY_NAME_MAX_LENGTH - suffix.length)}${suffix}`
}

function safeGet(storage: StorageLike | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function safeSet(storage: StorageLike | null, key: string, value: string): void {
  try {
    storage?.setItem(key, value)
  } catch {
    // QuotaExceededError / SecurityError — memory identity still covers the session.
  }
}

function defaultStorage(): StorageLike | null {
  try {
    const g = globalThis as unknown as { localStorage?: StorageLike }
    return g.localStorage ?? null
  } catch {
    return null
  }
}

function generateGuestId(): string {
  try {
    const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } }
    if (typeof g.crypto?.randomUUID === "function") return `guest:${g.crypto.randomUUID()}`
  } catch {
    // fall through to the Math.random fallback
  }
  return `guest:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function createIdentity(cfg: IdentityConfig): Identity {
  const storage = cfg.storage === undefined ? defaultStorage() : cfg.storage
  let id = safeGet(storage, cfg.storageKeys.guestId) || generateGuestId()
  let name = sanitizeDisplayName(safeGet(storage, cfg.storageKeys.displayName), cfg.randomName())
  safeSet(storage, cfg.storageKeys.guestId, id)
  safeSet(storage, cfg.storageKeys.displayName, name)

  return {
    guestId: () => id,
    displayName: () => name,
    setDisplayName: (raw: string) => {
      // An unsanitary save keeps the previous good name (T saveDisplayName).
      const next = sanitizeDisplayName(raw, name)
      name = next
      id = safeGet(storage, cfg.storageKeys.guestId) || id
      safeSet(storage, cfg.storageKeys.guestId, id)
      safeSet(storage, cfg.storageKeys.displayName, next)
      return next
    },
  }
}
