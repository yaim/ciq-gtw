/**
 * Conservative, non-overridable bounds and fixed timings for the OPTIONAL
 * Redis-backed cross-replica capacity layer (Phase 4D; specification sections
 * 19.2, 21.6, 22.2).
 *
 * These are the single source of truth for every bound this boundary enforces.
 * Relaxing one is a configuration-contract/security change, not a runtime
 * override. Nothing here is configurable: the only operator-facing values are
 * the pre-existing `MAX_CONCURRENT_REQUESTS*` limits, which become cluster-wide
 * when the feature is enabled.
 */
import { CAPACITY_LIMITS } from "../config/schema.js";

/** Version of the ZSET member encoding. Bumping it invalidates stored permits. */
export const CAPACITY_MEMBER_VERSION = 1;

/** Owner-token size, in bytes (128 bits of randomness). */
export const CAPACITY_OWNER_TOKEN_BYTES = 16;

/**
 * Capacity-scope size, in bytes: one SHA-256 digest, which is what
 * `deriveCapacityScope` produces. Both the server-side validator and the
 * TypeScript reply parser require exactly this many bytes, canonically encoded,
 * so a truncated or padded scope is never accepted as a distinct one.
 */
export const CAPACITY_SCOPE_BYTES = 32;

/**
 * The single-character delimiter separating a member's version, owner token, and
 * capacity scope.
 *
 * Both components are unpadded base64url (`[A-Za-z0-9_-]`), and `|` is outside
 * that alphabet, so a member splits unambiguously and no component value can
 * ever forge an extra field.
 */
export const CAPACITY_MEMBER_DELIMITER = "|";

/**
 * Maximum accepted UTF-8 length of one ZSET member, in bytes.
 *
 * A well-formed member is 68 bytes (`1` + delimiter + a 22-character owner token
 * + delimiter + a 43-character scope digest), so this is generous while still
 * bounding what the Lua validator may accept from a hostile writer.
 */
export const MAX_CAPACITY_MEMBER_BYTES = 128;

/**
 * Maximum accepted number of members in the registry.
 *
 * `ZCARD` is checked BEFORE any member is materialized, so an over-cardinality
 * registry is classified corrupt without its bytes ever being read. The bound is
 * four times the largest configurable global limit: an honest registry holds at
 * most `MAX_CONCURRENT_REQUESTS` live members, and the worst reachable case adds
 * one fully orphaned batch of the same size (a granted claim whose reply was
 * lost), which is itself self-limiting because grants stop once occupancy
 * reaches the global limit.
 *
 * Over-cardinality fails CLOSED and prunes nothing, so the gateway never
 * "repairs" the state. An honest gateway cannot reach this bound, because it
 * never grants beyond the configured global limit; getting here requires an
 * external writer. Recovery then depends on that writer: a registry whose TTL
 * the gateway last set clears itself within one lease window, but a key created
 * externally WITHOUT a TTL stays over-cardinality until an operator removes it,
 * and shared capacity stays `503` for as long as it does. That is the intended
 * fail-closed trade — the alternative is trusting state of unknown provenance.
 */
export const MAX_CAPACITY_REGISTRY_MEMBERS = 4 * CAPACITY_LIMITS.maxConcurrent.max;

/**
 * Maximum number of candidates in one claim batch.
 *
 * A batch can never usefully exceed the cluster-wide global limit, because the
 * script cannot grant more than that in total. It equals the largest
 * configurable `MAX_CONCURRENT_REQUESTS`, so the effective bound is always the
 * configured limit rather than this ceiling.
 */
export const MAX_CAPACITY_CLAIM_BATCH = CAPACITY_LIMITS.maxConcurrent.max;

/**
 * Extra lease granted beyond the request's own total deadline, and the absolute
 * ceiling on any lease.
 *
 * The lease is a CRASH REAPER, not a liveness mechanism: there is deliberately
 * no heartbeat and no renewal script. It is therefore derived from the holder's
 * own deadline plus a margin, so a live request's permit cannot expire
 * mid-completion — the request's own deadline always fires first — while a
 * hard-killed replica's permits are reclaimed within a bounded window.
 *
 * The ceiling is the largest configurable model deadline
 * (`MODEL_CONFIG_LIMITS.requestTimeoutMs.max`, 600 000 ms) plus the margin, so
 * within the configured bounds it never truncates a reachable value; it exists
 * so an impossible deadline can never mint an unbounded lease.
 */
export const CAPACITY_LEASE_MARGIN_MS = 30_000;
/** Absolute ceiling for one permit's lease, in ms. */
export const MAX_CAPACITY_LEASE_MS = 630_000;

/**
 * Bounded retry schedule for the ONE outcome that is worth retrying: a
 * well-formed claim that granted nothing because the cluster is currently at its
 * limit.
 *
 * An unavailable, corrupt, or ambiguous claim reply is NEVER retried — the
 * gateway cannot know whether a mutation applied, so a retry could double-count
 * a permit it already holds.
 */
export const CAPACITY_RETRY_INITIAL_MS = 100;
/** Multiplicative backoff factor applied per consecutive full-capacity outcome. */
export const CAPACITY_RETRY_BACKOFF_FACTOR = 1.25;
/** Upper clamp for the retry delay, in ms. */
export const CAPACITY_RETRY_MAX_MS = 1_000;
/**
 * Symmetric jitter ratio applied to the computed retry delay.
 *
 * Replicas that all became full at the same instant would otherwise retry in
 * lockstep and keep colliding on the same registry.
 */
export const CAPACITY_RETRY_JITTER_RATIO = 0.25;
