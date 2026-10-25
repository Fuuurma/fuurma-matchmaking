import { describe, expect, it } from "vitest"
import { type ErrorCode, FuurmaError, mapRoomRefusal } from "../../src/errors"

describe("FuurmaError", () => {
  it("carries code, terminal flag, and optional transport detail", () => {
    const err = new FuurmaError("room-full", "Room is full", {
      terminal: true,
      status: 200,
    })
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe("room-full")
    expect(err.message).toBe("Room is full")
    expect(err.terminal).toBe(true)
    expect(err.status).toBe(200)
    expect(err.name).toBe("FuurmaError")
  })

  it("defaults to terminal", () => {
    expect(new FuurmaError("cancelled", "x").terminal).toBe(true)
  })
})

describe("mapRoomRefusal (server text/code -> ErrorCode)", () => {
  const cases: Array<{ text: string; code?: string; want: ErrorCode }> = [
    { text: "room full", want: "room-full" },
    { text: "Room is full", want: "room-full" },
    { text: "already connected from another tab", want: "another-tab" },
    { text: "reconnect credential required", want: "credential" },
    { text: "legacy slot expired — rejoin as a new player", want: "credential" },
    { text: "join capability required", want: "capability" },
    { text: "hello handshake expired", want: "handshake-timeout" },
    // The server now sends a machine code for role conflicts
    // (M room.ts "role-taken"); it wins over the message text.
    {
      text: "That room code is already in use",
      code: "role-taken",
      want: "role-conflict",
    },
    { text: "totally unknown refusal", want: "protocol" },
  ]
  for (const { text, code, want } of cases) {
    it(`maps ${JSON.stringify(text)} to ${want}`, () => {
      expect(mapRoomRefusal(text, code)).toBe(want)
    })
  }
})
