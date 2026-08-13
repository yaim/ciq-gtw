/**
 * Default (production) implementations of the generation seams: the wall-clock
 * and the completion-id generator. Tests inject deterministic fakes instead.
 */
import { randomBytes } from "node:crypto";
import type { Clock, IdGenerator } from "./types.js";

/** The real millisecond wall clock. */
export const systemClock: Clock = {
  nowMs: () => Date.now(),
};

/** Prefix for public chat-completion identifiers (specification section 8.8). */
export const COMPLETION_ID_PREFIX = "chatcmpl_ciq_";

/**
 * Build a completion-id generator producing unique, opaque
 * `chatcmpl_ciq_<hex>` ids. The random suffix carries no request/thread/user
 * information.
 */
export function createIdGenerator(
  randomSuffix: () => string = () => randomBytes(16).toString("hex"),
): IdGenerator {
  return {
    completionId: () => `${COMPLETION_ID_PREFIX}${randomSuffix()}`,
  };
}
