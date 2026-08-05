/**
 * Shared helpers for the matchmaking Worker and Durable Objects.
 */

/** Games served by this Worker. Used by both the router and the room DO. */
export const ALLOWED_GAMES = new Set(["tictactoe", "uno-chess"])

/** Max WebSocket message size (64 KiB — generous for turn-based game moves). */
export const MAX_MESSAGE_BYTES = 64 * 1024

/** Max length of a display name after sanitization. */
export const MAX_DISPLAY_NAME_LENGTH = 20

/** Bounds for matchmaking identity fields accepted from browsers. */
export const MAX_PEER_ID_LENGTH = 128
export const MAX_GUEST_ID_LENGTH = 64
export const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/

export function isValidRoomId(value: string): boolean {
  return ROOM_ID_PATTERN.test(value)
}

/**
 * Max UTF-8 byte length for a raw `displayName` payload before sanitization.
 *
 * The validation contract calls out "UTF-8 byte bounds" so we measure the
 * UTF-8 byte length of the inbound string rather than `.length` (UTF-16
 * code units). A 100-emoji name is 200 chars / 400 bytes; without this
 * check, `.length`-only validation accepts up to ~1024 bytes per 4-byte
 * glyph before tripping, which is far beyond the 256-char-after-slice
 * limit and lets crafted payloads inflate stored names. Enforcing an
 * explicit UTF-8 ceiling also keeps the join body well under the 1 MiB
 * Worker request body limit. Identity fields (`peerId` / `guestId`)
 * remain capped on `.length` because they are opaque client IDs, not
 * user-rendered strings.
 */
export const MAX_DISPLAY_NAME_UTF8_BYTES = 256

/** Measure a string's UTF-8 byte length using the platform TextEncoder. */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

/**
 * Sanitize a user-supplied display name for safe storage and relay.
 *
 * Strips control characters and HTML-special characters that could cause
 * issues if a game client renders the name in the DOM without escaping.
 * Falls back to "Guest" when the result is too short or empty.
 */
export function sanitizeDisplayName(value: string | undefined | null): string {
  const safe = (value ?? "Guest")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional sanitizer
    .replace(/[\u0000-\u001F\u007F<>"'`]/g, "")
    .trim()
    .slice(0, MAX_DISPLAY_NAME_LENGTH)
  return safe.length >= 2 ? safe : "Guest"
}

/** CORS headers applied to all JSON responses. */
export function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  }
}

/** Build a JSON Response with CORS headers. */
export function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
      ...extraHeaders,
    },
  })
}

/**
 * Emit a structured log line. Cloudflare Workers observability captures
 * `console.warn`/`console.error` as structured logs when observability is
 * enabled in wrangler.jsonc.
 */
export function logEvent(
  level: "info" | "warn" | "error",
  event: string,
  fields?: Record<string, unknown>,
): void {
  const payload = JSON.stringify({ event, ...fields })
  if (level === "error") console.error(payload)
  else if (level === "warn") console.warn(payload)
  else console.log(payload)
}
