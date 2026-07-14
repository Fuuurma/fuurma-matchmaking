/**
 * Shared helpers for the matchmaking Worker and Durable Objects.
 */

/** Games served by this Worker. Used by both the router and the room DO. */
export const ALLOWED_GAMES = new Set(["tictactoe", "uno-chess"])

/** Max WebSocket message size (64 KiB — generous for turn-based game moves). */
export const MAX_MESSAGE_BYTES = 64 * 1024

/** Max length of a display name after sanitization. */
export const MAX_DISPLAY_NAME_LENGTH = 20

/**
 * Sanitize a user-supplied display name for safe storage and relay.
 *
 * Strips control characters and HTML-special characters that could cause
 * issues if a game client renders the name in the DOM without escaping.
 * Falls back to "Guest" when the result is too short or empty.
 */
export function sanitizeDisplayName(value: string | undefined | null): string {
  const safe = (value ?? "Guest")
    // Strip control chars (0x00-0x1F, 0x7F) and HTML-special chars.
    .replace(/[\x00-\x1F\x7F<>"'`]/g, "")
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
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
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
