/**
 * Matchmaking HTTP client: join / poll / leave / health against the
 * Worker's `/api/matchmaking/<game>` routes, plus the queue poll loop.
 *
 * Takes T's timeouts, `{error}` parsing, 1 s → 4 s backoff, failure
 * tolerance and 2-minute cap, and G's AbortSignal plumbing, `Retry-After`
 * honoring, and content-type guard. `baseUrl` is always the Worker ORIGIN
 * (the SDK appends the routes); an empty origin refuses instead of
 * dialling localhost (T 3.8). `fetch` is injected; pagehide wiring takes a
 * subscribe function so no DOM type enters the SDK.
 */

import { FuurmaError, mapHttpStatus } from "./errors"

export interface MatchParticipant {
  peerId: string
  displayName: string
  guestId: string
}

export interface Match {
  roomId: string
  role: "host" | "guest"
  host?: MatchParticipant
  guest?: MatchParticipant
  wsUrl?: string
  [key: string]: unknown
}

export type MatchmakingResponse =
  | { status: "waiting"; ticket: string; roomId: string }
  | { status: "matched"; match: Match; slotToken?: string }

export interface Health {
  waiting: number
  matches: number
  /** Everyone a visitor could plausibly meet: queue + both sides of each match. */
  players: number
}

export interface JoinParams {
  peerId: string
  displayName: string
  guestId: string
}

export interface RequestOptions {
  signal?: AbortSignal
}

export interface LeaveOptions extends RequestOptions {
  /** Lets the request outlive a closing page (the pagehide release path). */
  keepalive?: boolean
}

export interface WaitOptions extends RequestOptions {
  onWaiting?: () => void
  /** Cap on the whole search. Default 120_000 (G's race; T's 2-min cap). */
  maxWaitMs?: number
  /** Consecutive poll failures tolerated before the search ends. Default 5. */
  maxConsecutiveFailures?: number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

export interface SeatClaim {
  roomId: string
  role: "host" | "guest"
  slotToken?: string
}

export interface MatchmakingClientOptions {
  baseUrl: string
  game: string
  fetchFn?: typeof fetch
  /** Per-request timeout for join/poll/health. Default 10_000 (T). */
  timeoutMs?: number
  /** Per-request timeout for leave. Default 5_000 (T). */
  leaveTimeoutMs?: number
}

export const MATCHMAKING_UNAVAILABLE_MESSAGE = "Online play isn't available in this build."

export const MATCH_POLL_INITIAL_DELAY_MS = 1_000
export const MATCH_POLL_MAX_DELAY_MS = 4_000
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_LEAVE_TIMEOUT_MS = 5_000
const DEFAULT_MAX_WAIT_MS = 120_000
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5
/** A server's Retry-After is honoured, but never longer than this. */
const MAX_RETRY_AFTER_MS = 30_000

/** False when `baseUrl` is unset: gate UI and block create/join (T 3.8). */
export function isConfigured(baseUrl: string | undefined): boolean {
  return typeof baseUrl === "string" && baseUrl.length > 0
}

/** Poll delay after `attempt` polls: 1 s, 2 s, then 4 s for the search. */
export function getMatchPollDelay(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 0) return MATCH_POLL_INITIAL_DELAY_MS
  return Math.min(MATCH_POLL_INITIAL_DELAY_MS * 2 ** attempt, MATCH_POLL_MAX_DELAY_MS)
}

/**
 * The wire is not the type system: a 200 with `{}`, an error body, or a
 * newer shape must not flow through as a cast (T devin 2026-09-10).
 * `match.role`/`match.roomId` come from the poll result itself (G-correct;
 * T 3.2 read them from the waiting response).
 */
export function parseMatchmakingResponse(data: unknown): MatchmakingResponse {
  if (typeof data !== "object" || data === null) {
    throw new FuurmaError("protocol", "Malformed matchmaking response: not an object", {
      terminal: true,
    })
  }
  const d = data as Record<string, unknown>
  if (d.status === "waiting" && typeof d.ticket === "string" && typeof d.roomId === "string") {
    return { status: "waiting", ticket: d.ticket, roomId: d.roomId }
  }
  if (d.status === "matched" && typeof d.match === "object" && d.match !== null) {
    const m = d.match as Record<string, unknown>
    if (typeof m.roomId === "string" && m.roomId && (m.role === "host" || m.role === "guest")) {
      const match: Match = {
        ...(m as Record<string, unknown>),
        roomId: m.roomId,
        role: m.role,
      } as Match
      const slotToken = typeof d.slotToken === "string" ? d.slotToken : undefined
      return slotToken === undefined
        ? { status: "matched", match }
        : { status: "matched", match, slotToken }
    }
  }
  throw new FuurmaError("protocol", "Malformed matchmaking response: unexpected shape", {
    terminal: true,
  })
}

function isParticipant(value: unknown): value is MatchParticipant {
  if (typeof value !== "object" || value === null) return false
  const p = value as Record<string, unknown>
  return (
    typeof p.peerId === "string" &&
    typeof p.displayName === "string" &&
    typeof p.guestId === "string"
  )
}

/** Strict participant check for callers that need host+guest profiles. */
export function hasParticipants(match: Match): boolean {
  return isParticipant(match.host) && isParticipant(match.guest)
}

/**
 * Same rule as the matchmaking response: a proxy error page or future
 * shape must not reach the UI as a number. Unexpected input yields null,
 * which callers render as "count unavailable", never as a confident 0.
 */
export function parseHealthBody(data: unknown): Omit<Health, "players"> | null {
  if (typeof data !== "object" || data === null) return null
  const d = data as Record<string, unknown>
  if (d.ok !== true || typeof d.game !== "string") return null
  const { waiting, matches } = d
  if (
    typeof waiting !== "number" ||
    typeof matches !== "number" ||
    !Number.isInteger(waiting) ||
    !Number.isInteger(matches) ||
    waiting < 0 ||
    matches < 0
  ) {
    return null
  }
  return { waiting, matches }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new FuurmaError("cancelled", "Matchmaking cancelled", { terminal: true }))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new FuurmaError("cancelled", "Matchmaking cancelled", { terminal: true }))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new FuurmaError("cancelled", "Matchmaking cancelled", { terminal: true })
  }
}

export class MatchmakingClient {
  private readonly baseUrl: string
  private readonly game: string
  private readonly fetchFn: typeof fetch
  private readonly timeoutMs: number
  private readonly leaveTimeoutMs: number

  constructor(opts: MatchmakingClientOptions) {
    if (!isConfigured(opts.baseUrl)) {
      throw new FuurmaError("unavailable", MATCHMAKING_UNAVAILABLE_MESSAGE, { terminal: true })
    }
    this.baseUrl = opts.baseUrl.replace(/\/$/, "")
    this.game = opts.game
    this.fetchFn =
      opts.fetchFn ?? (globalThis as unknown as { fetch: typeof fetch }).fetch.bind(globalThis)
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.leaveTimeoutMs = opts.leaveTimeoutMs ?? DEFAULT_LEAVE_TIMEOUT_MS
  }

  private path(route: string): string {
    return `${this.baseUrl}/api/matchmaking/${this.game}${route}`
  }

  /**
   * One request with a hard timeout composed with the caller's signal.
   * Only the caller's cancel ends silently; a timeout is a transient
   * `unavailable` so the poll loop can survive the blip.
   */
  private async request(path: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
    const callerSignal = init.signal ?? null
    throwIfCancelled(callerSignal ?? undefined)
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const forwardAbort = (): void => controller.abort()
    callerSignal?.addEventListener("abort", forwardAbort, { once: true })
    try {
      const res = await this.fetchFn(path, { ...init, signal: controller.signal })
      if (!res.ok) throw await failureOf(res)
      const contentType = res.headers.get("content-type") ?? ""
      if (!contentType.includes("application/json")) {
        throw new FuurmaError(
          "protocol",
          `Matchmaking service did not return JSON at ${this.baseUrl}`,
          { terminal: true, status: res.status },
        )
      }
      return (await res.json()) as unknown
    } catch (err) {
      if (err instanceof FuurmaError) throw err
      if (callerSignal?.aborted) {
        throw new FuurmaError("cancelled", "Matchmaking cancelled", { terminal: true })
      }
      if (timedOut) {
        throw new FuurmaError("unavailable", "Matchmaking service did not answer in time", {
          terminal: false,
        })
      }
      throw new FuurmaError(
        "unavailable",
        err instanceof Error ? err.message : "Matchmaking request failed",
        { terminal: false },
      )
    } finally {
      clearTimeout(timer)
      callerSignal?.removeEventListener("abort", forwardAbort)
    }
  }

  async join(params: JoinParams, opts?: RequestOptions): Promise<MatchmakingResponse> {
    const data = await this.request(
      this.path("/join"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
        signal: opts?.signal,
      },
      this.timeoutMs,
    )
    return parseMatchmakingResponse(data)
  }

  async poll(ticket: string, opts?: RequestOptions): Promise<MatchmakingResponse> {
    const data = await this.request(
      this.path(`/poll?ticket=${encodeURIComponent(ticket)}`),
      { method: "GET", signal: opts?.signal },
      this.timeoutMs,
    )
    return parseMatchmakingResponse(data)
  }

  async leave(ticket: string, opts?: LeaveOptions): Promise<void> {
    // `keepalive` is a browser RequestInit field the Workers lib omits;
    // the intersection keeps the SDK compiling under both (erasable TS).
    const init: RequestInit & { keepalive?: boolean } = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket }),
      signal: opts?.signal,
      keepalive: opts?.keepalive === true,
    }
    await this.request(this.path("/leave"), init, this.leaveTimeoutMs)
  }

  /** Throws on any failure; callers treat a throw as "unknown", never as 0. */
  async health(opts?: RequestOptions): Promise<Health> {
    const data = await this.request(
      this.path("/health"),
      { method: "GET", signal: opts?.signal },
      this.timeoutMs,
    )
    const parsed = parseHealthBody(data)
    if (!parsed)
      throw new FuurmaError("protocol", "Malformed matchmaking health response", { terminal: true })
    return { ...parsed, players: parsed.waiting + parsed.matches * 2 }
  }

  /**
   * Poll until `matched`, tolerating blips: non-terminal failures
   * (timeouts, 5xx, 429) consume the failure budget instead of ending the
   * search; refusals, cancel, the wait cap, or a spent budget end it.
   */
  async waitForMatch(ticket: string, opts?: WaitOptions): Promise<SeatClaim> {
    const sleep = opts?.sleep ?? defaultSleep
    const maxWaitMs = opts?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS
    const maxFailures = opts?.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES
    const startedAt = Date.now()
    let failures = 0
    for (let attempt = 0; ; attempt++) {
      throwIfCancelled(opts?.signal)
      let wait = getMatchPollDelay(attempt)
      try {
        const result = await this.poll(ticket, { signal: opts?.signal })
        failures = 0
        if (result.status === "matched") {
          const claim: SeatClaim = { roomId: result.match.roomId, role: result.match.role }
          if (result.slotToken !== undefined) claim.slotToken = result.slotToken
          return claim
        }
        opts?.onWaiting?.()
      } catch (err) {
        if (err instanceof FuurmaError && err.code === "cancelled") throw err
        throwIfCancelled(opts?.signal)
        const terminal = err instanceof FuurmaError ? err.terminal : false
        failures += 1
        if (terminal || failures >= maxFailures) throw err
        if (err instanceof FuurmaError && err.retryAfterSec !== undefined) {
          wait = Math.max(wait, Math.min(err.retryAfterSec * 1000, MAX_RETRY_AFTER_MS))
        }
      }
      if (Date.now() - startedAt + wait > maxWaitMs) {
        throw new FuurmaError("peer-never-arrived", "Matchmaking did not pair in time", {
          terminal: true,
        })
      }
      await sleep(wait, opts?.signal)
    }
  }
}

/**
 * Release `ticket` when the page dies (T's pagehide keepalive leave).
 * `subscribe` wires the platform event (e.g. `window.addEventListener`
 * for `"pagehide"`); the SDK never touches the DOM itself.
 */
export function releaseOnPageHide(
  ticket: string,
  client: Pick<MatchmakingClient, "leave">,
  subscribe: (fire: () => void) => () => void,
): () => void {
  return subscribe(() => {
    client.leave(ticket, { keepalive: true }).catch(() => {
      // The page is gone; there is nobody to report to.
    })
  })
}

/** The Worker answers failures with `{error}` and, when busy, `Retry-After` seconds. */
async function failureOf(res: Response): Promise<FuurmaError> {
  const text = await res.text().catch(() => "")
  const message = parseErrorBody(text.trim()) || `Matchmaking request failed (${res.status})`
  const retryAfterSec = parseRetryAfter(res.headers.get("Retry-After"))
  const code = mapHttpStatus(res.status)
  const terminal = !(res.status >= 500 || res.status === 408 || res.status === 429)
  return new FuurmaError(
    code,
    retryAfterSec !== undefined
      ? `${message.replace(/[.!\s]+$/, "")}. Try again in ${retryAfterSec}s.`
      : message,
    terminal ? { terminal, status: res.status } : { terminal, status: res.status, retryAfterSec },
  )
}

function parseErrorBody(text: string): string {
  if (!text) return ""
  try {
    const body = JSON.parse(text) as { error?: unknown } | null
    if (typeof body?.error === "string" && body.error.trim()) {
      const trimmed = body.error.trim()
      return trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
    }
  } catch {
    // Not JSON: a short plain-text body is still the server's own words.
    if (text.length <= 200 && !/^[<{[]/.test(text)) return text
  }
  return ""
}

function parseRetryAfter(raw: string | null): number | undefined {
  if (raw === null) return undefined
  const sec = Number(raw)
  if (!Number.isFinite(sec) || sec <= 0) return undefined
  return sec
}

/**
 * WebSocket URL for a room on the Worker's relay. The `game` query param
 * is intentionally NOT set here — RoomSocket owns it (single writer).
 */
export function buildRoomWsUrl(roomId: string, baseUrl: string): string {
  if (!isConfigured(baseUrl)) {
    throw new FuurmaError("unavailable", MATCHMAKING_UNAVAILABLE_MESSAGE, { terminal: true })
  }
  const httpUrl = new URL(`/room/${roomId}`, baseUrl)
  httpUrl.protocol = httpUrl.protocol === "https:" ? "wss:" : "ws:"
  return httpUrl.toString()
}
