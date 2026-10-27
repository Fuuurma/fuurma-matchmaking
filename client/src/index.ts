/**
 * `@fuurma/online-client` — shared Tier-1 online client SDK.
 *
 * Transport and protocol only: the room socket state machine, credentials,
 * matchmaking HTTP, identity/sanitizer, room codes/invites, and presence.
 * Games own all game semantics (frame schemas, authority, timers, rematch).
 */
export type { ErrorCode, FuurmaErrorOptions } from "./errors"
export { FuurmaError, mapHttpStatus, mapRoomRefusal } from "./errors"
export type { Identity, IdentityConfig, StorageLike } from "./identity"
export {
  createIdentity,
  filterDisplayNameInput,
  resolveNameCollision,
  sanitizeDisplayName,
} from "./identity"
export type {
  Health,
  JoinParams,
  LeaveOptions,
  Match,
  MatchmakingClientOptions,
  MatchmakingResponse,
  MatchParticipant,
  RequestOptions,
  SeatClaim,
  WaitOptions,
} from "./matchmaking"
export {
  buildRoomWsUrl,
  getMatchPollDelay,
  hasParticipants,
  isConfigured,
  MATCH_POLL_INITIAL_DELAY_MS,
  MATCH_POLL_MAX_DELAY_MS,
  MATCHMAKING_UNAVAILABLE_MESSAGE,
  MatchmakingClient,
  parseHealthBody,
  parseMatchmakingResponse,
  releaseOnPageHide,
} from "./matchmaking"
export type { Presence, PresenceOptions } from "./presence"
export { createPresence } from "./presence"
export type { LastRoom, NormalizeOptions } from "./roomCode"
export {
  buildInviteLink,
  clearRoomCodeFromUrl,
  DEFAULT_CODE_LENGTH,
  generateRoomCode,
  normalizeRoomCode,
  ROOM_ID_PATTERN,
  readRoomCodeFromUrl,
  shouldAutoJoinInvite,
} from "./roomCode"
export type {
  MessageDataEvent,
  PeerJoinedMessage,
  PeerLeftMessage,
  PeerProfile,
  PeerReconnectedMessage,
  ReconnectPolicy,
  RelayErrorMessage,
  RoomEnvelope,
  RoomMessage,
  RoomRole,
  RoomSession,
  RoomSocketOptions,
  RoomStatus,
  WebSocketLike,
  WelcomeMessage,
} from "./socket"
export { DEFAULT_HANDSHAKE_TIMEOUT_MS, RoomSocket, SOCKET_OPEN } from "./socket"
