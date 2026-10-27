/**
 * Presence: a tiny framework-agnostic store for the "N players online"
 * readout (T's `usePlayerCount` module logic minus React).
 *
 * One poller serves every reader: `subscribe`/`getSnapshot` fit
 * `useSyncExternalStore` directly, and any other UI can poll the snapshot.
 * The snapshot stays null until the first successful read (the UI says
 * nothing rather than lying with a zero); a failed refresh keeps the last
 * good number and backs off instead of hammering an unhappy Worker.
 */

import type { Health } from "./matchmaking"

export interface PresenceOptions {
  load: (signal?: AbortSignal) => Promise<Health>
  /** Healthy cadence. Default 15_000 (T). */
  pollMs?: number
  /** Cadence after a failure. Default 30_000 (T). */
  errorBackoffMs?: number
  /** False pauses polling (e.g. hidden tab); the next tick catches up. */
  isActive?: () => boolean
}

export interface Presence {
  subscribe(listener: () => void): () => void
  getSnapshot(): Health | null
  start(): void
  stop(): void
  refresh(): Promise<void>
}

const DEFAULT_POLL_MS = 15_000
const DEFAULT_ERROR_BACKOFF_MS = 30_000

export function createPresence(opts: PresenceOptions): Presence {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS
  const errorBackoffMs = opts.errorBackoffMs ?? DEFAULT_ERROR_BACKOFF_MS
  const isActive = opts.isActive ?? (() => true)
  const listeners = new Set<() => void>()
  let snapshot: Health | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight = false
  let nextDelayMs = pollMs
  let started = false

  const publish = (next: Health | null): void => {
    if (next === snapshot) return
    snapshot = next
    for (const listener of listeners) listener()
  }

  const schedule = (): void => {
    if (!started || timer) return
    timer = setTimeout(() => {
      timer = null
      void tick()
    }, nextDelayMs)
  }

  const pollOnce = async (): Promise<void> => {
    if (inFlight) return
    if (!isActive()) {
      nextDelayMs = pollMs
      return
    }
    inFlight = true
    try {
      publish(await opts.load())
      nextDelayMs = pollMs
    } catch {
      nextDelayMs = errorBackoffMs
    } finally {
      inFlight = false
    }
  }

  const tick = async (): Promise<void> => {
    if (!started) return
    await pollOnce()
    schedule()
  }

  return {
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: (): Health | null => snapshot,
    start: (): void => {
      if (started) return
      started = true
      void tick()
    },
    stop: (): void => {
      started = false
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    },
    refresh: async (): Promise<void> => {
      await pollOnce()
    },
  }
}
