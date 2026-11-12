/**
 * Shared helpers for the matchmaking Worker and Durable Objects.
 */

/** Games served by this Worker. Used by both the router and the room DO. */
export const ALLOWED_GAMES = new Set(["tictactoe", "gambit-deck"])

/**
 * Max WebSocket message size — 512 KiB, matching the gambit-deck client's
 * own MAX_MESSAGE_SIZE_BYTES (src/lib/room.ts). The two caps must agree:
 * a state_snapshot between the client's accept limit and this relay's
 * refusal left the host having reset its sequence epoch while the guest
 * never applied the snapshot (gambit-deck F1297 — a ~226-move game
 * clears the old 64 KiB at ~257 B per move-history record).
 */
export const MAX_MESSAGE_BYTES = 512 * 1024

/**
 * Max JSON request body for join/leave (8 KiB — legitimate payloads are
 * under 1 KiB: peerId ≤128 chars, guestId ≤64, displayName ≤256 bytes).
 * Enforced on declared Content-Length AND on streamed bytes so a missing
 * or false length header cannot bypass it (MM-03).
 */
export const MAX_JSON_BODY_BYTES = 8 * 1024

/**
 * Compares two secrets without leaking, through timing, how long a matching
 * prefix is. A length mismatch returns early: tokens here are fixed-size hex, so
 * the length is not a secret.
 */
export function secretsMatch(a: string, b: string): boolean {
  const encoder = new TextEncoder()
  const left = encoder.encode(a)
  const right = encoder.encode(b)
  return left.byteLength === right.byteLength && crypto.subtle.timingSafeEqual(left, right)
}

/** Max length of a display name after sanitization. */
const MAX_DISPLAY_NAME_LENGTH = 20

/** Bounds for matchmaking identity fields accepted from browsers. */
export const MAX_PEER_ID_LENGTH = 128
export const MAX_GUEST_ID_LENGTH = 64
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/

/**
 * Max length of a client-presented ticket (`retryTicket`). Server-issued
 * tickets are 32 hex chars (128 bits), so this only has to reject obviously
 * bogus or oversized payloads before they reach the credential comparison.
 */
export const MAX_TICKET_LENGTH = 64

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

/**
 * Baseline security headers stamped on every Worker response — the standard
 * set a header probe grades. CSP is the API shape (`default-src 'none'` —
 * the Worker serves JSON and WebSocket, never a document) plus
 * `frame-ancestors 'none'`; `X-Frame-Options` backs the CSP for agents that
 * ignore it; `nosniff` stops content-type sniffing of the JSON bodies;
 * `no-referrer` keeps request URLs out of downstream logs; HSTS and
 * Permissions-Policy round out the set.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
}

/**
 * CORS headers plus the security set, applied to all JSON responses.
 */
export function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...SECURITY_HEADERS,
  }
}

/**
 * Stamp the security set onto a response at the Worker edge. Durable Object
 * passthrough responses carry immutable headers, so a response missing any
 * of the set is rebuilt rather than mutated — WebSocket upgrades cannot be
 * reconstructed without losing the socket, so the room DO sets the same
 * headers at construction instead (see GameRoomDO.fetch).
 */
export function withSecurityHeaders(response: Response): Response {
  if (response.status === 101 || response.webSocket) return response
  const headers = new Headers(response.headers)
  let missing = false
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(name)) {
      headers.set(name, value)
      missing = true
    }
  }
  if (!missing) return response
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
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
