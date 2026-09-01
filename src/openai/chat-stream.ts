/**
 * Buffered synthetic SSE encoder for `stream: true` chat completions
 * (specification sections 8.8, 14). This module is PURE: it builds the
 * `chat.completion.chunk` objects, the deterministic content-delta split, and
 * the SSE record strings. It never touches a socket, timer, or Node response —
 * the transport (`src/api/chat-stream-response.ts`) owns those.
 *
 * The gateway does NOT stream from CollectivIQ: the complete answer is obtained
 * by authoritative polling and only THEN split into deltas. Synthetic streaming
 * keeps the client connection alive; it cannot improve time-to-first-answer
 * content. `usage` is never emitted (an estimate must not be presented as exact
 * usage).
 */
import type { OpenAIErrorBody } from "./errors.js";
import type { ParsedToolCall } from "../tools/index.js";

/**
 * The minimum a stream needs to encode one completed generation: the trusted
 * discriminator plus either assistant text or validated tool calls.
 *
 * A live `CompletionResult` satisfies this structurally (it merely adds the
 * internal `upstreamThreadId`), and so does a decrypted cached completion
 * replayed from Redis — so both drive the SAME deterministic frame sequence.
 */
export type StreamableResult =
  | { readonly kind: "text"; readonly content: string }
  | { readonly kind: "tool_calls"; readonly toolCalls: readonly ParsedToolCall[] };

/** The stable identity shared by every frame of one streamed response. */
export interface StreamMeta {
  /** The `chatcmpl_ciq_*` id, identical across every chunk. */
  readonly id: string;
  /** Unix-seconds creation time, identical across every chunk. */
  readonly created: number;
  /** The requested virtual-model id, echoed verbatim in every chunk. */
  readonly model: string;
  /** The single choice index used for the whole stream. */
  readonly index: number;
}

/** One streamed tool-call delta (a complete, indexed function call). */
export interface StreamToolCallDelta {
  readonly index: number;
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}

/** The delta payload of a chunk: a role opener, a content piece, tool calls, or empty. */
export interface ChunkDelta {
  readonly role?: "assistant";
  readonly content?: string;
  readonly tool_calls?: readonly StreamToolCallDelta[];
}

/** The terminal `finish_reason` for a stream: text `stop` or `tool_calls`. */
export type StreamFinishReason = "stop" | "tool_calls" | null;

/** One `chat.completion.chunk` streaming object. */
export interface ChatCompletionChunk {
  readonly id: string;
  readonly object: "chat.completion.chunk";
  readonly created: number;
  readonly model: string;
  readonly choices: readonly {
    readonly index: number;
    readonly delta: ChunkDelta;
    readonly finish_reason: StreamFinishReason;
  }[];
}

/** Target chunk size, in Unicode code points. */
export const TARGET_CHUNK_CODEPOINTS = 128;
/** Hard maximum chunk size, in Unicode code points. */
export const MAX_CHUNK_CODEPOINTS = 256;
/** Preferred minimum chunk size; a shorter FINAL remainder is still allowed. */
export const MIN_CHUNK_CODEPOINTS = 32;

/** The keep-alive SSE comment emitted while polling waits (no data record). */
export const KEEP_ALIVE_COMMENT = ": collectiviq-gateway keep-alive\n\n";
/** The terminal SSE record that ends every stream. */
export const DONE_FRAME = "data: [DONE]\n\n";

function chunk(
  meta: StreamMeta,
  delta: ChunkDelta,
  finish: StreamFinishReason,
): ChatCompletionChunk {
  return {
    id: meta.id,
    object: "chat.completion.chunk",
    created: meta.created,
    model: meta.model,
    choices: [{ index: meta.index, delta, finish_reason: finish }],
  };
}

/** The assistant-role opener chunk (emitted before any upstream work). */
export function roleChunk(meta: StreamMeta): ChatCompletionChunk {
  return chunk(meta, { role: "assistant" }, null);
}

/** A content-delta chunk carrying one piece of the answer. */
export function contentChunk(meta: StreamMeta, content: string): ChatCompletionChunk {
  return chunk(meta, { content }, null);
}

/**
 * A single chunk carrying every tool call as a complete, indexed delta
 * (specification section 14.4). Ids are the gateway-generated `call_ciq_*` ids
 * and are stable across the response; arguments are the validated JSON strings.
 */
export function toolCallsChunk(
  meta: StreamMeta,
  calls: readonly ParsedToolCall[],
): ChatCompletionChunk {
  const tool_calls: StreamToolCallDelta[] = calls.map((call, index) => ({
    index,
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: call.argumentsJson },
  }));
  return chunk(meta, { tool_calls }, null);
}

/** The terminal chunk: empty delta, `finish_reason: "stop"`. */
export function terminalChunk(meta: StreamMeta): ChatCompletionChunk {
  return chunk(meta, {}, "stop");
}

/** The terminal chunk for a tool-call stream: empty delta, `finish_reason: "tool_calls"`. */
export function terminalToolChunk(meta: StreamMeta): ChatCompletionChunk {
  return chunk(meta, {}, "tool_calls");
}

/** Serialize any chunk object into one SSE `data:` record (record + blank line). */
export function sseData(value: ChatCompletionChunk): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

/**
 * Serialize a safe OpenAI error envelope into one SSE `data:` record. The body
 * is the already-content-free `{ error: { ... } }` object; no upstream body,
 * credential, prompt, answer, path, or stack ever appears here.
 */
export function sseError(body: OpenAIErrorBody): string {
  return `data: ${JSON.stringify(body)}\n\n`;
}

function isWhitespace(cp: string): boolean {
  // Any Unicode whitespace (spaces, tabs, newlines, NBSP, …).
  return /\s/u.test(cp);
}

const SENTENCE_PUNCT = new Set([".", "!", "?", "。", "！", "？", "…"]);
const TRAILING_AFTER_PUNCT = new Set(['"', "'", ")", "]", "}", "”", "’", "»", "）"]);

/**
 * Classify the boundary strength at code-point index `end` (a cut here yields a
 * chunk ending just before `end`). Higher is more preferred:
 *   3 = paragraph break (a blank-line / double-newline just closed),
 *   2 = sentence end (terminal punctuation then whitespace),
 *   1 = any whitespace boundary (the current chunk ends on whitespace),
 *   0 = no natural boundary.
 * `end` is always a code-point boundary (we operate on a code-point array), so a
 * cut is inherently surrogate-pair safe.
 */
function boundaryStrength(cps: readonly string[], end: number): number {
  const prev = cps[end - 1];
  if (prev === undefined || !isWhitespace(prev)) return 0;
  // Paragraph: the whitespace run ending at `end` contains at least two newlines.
  let newlines = 0;
  let k = end - 1;
  while (k >= 0) {
    const cp = cps[k];
    if (cp === undefined || !isWhitespace(cp)) break;
    if (cp === "\n") newlines += 1;
    k -= 1;
  }
  if (newlines >= 2) return 3;
  // Sentence: the last non-whitespace before the run is terminal punctuation
  // (optionally after a closing quote/bracket).
  let p = k;
  const maybeTrailing = cps[p];
  if (maybeTrailing !== undefined && TRAILING_AFTER_PUNCT.has(maybeTrailing)) p -= 1;
  const punct = cps[p];
  if (punct !== undefined && SENTENCE_PUNCT.has(punct)) return 2;
  return 1;
}

/**
 * Split `text` into deterministic, code-point-safe content deltas.
 *
 * Guarantees:
 *  - concatenating the results reproduces `text` EXACTLY (no trimming, no loss);
 *  - no delta ever splits a Unicode code point (surrogate pairs stay intact);
 *  - each delta is at most {@link MAX_CHUNK_CODEPOINTS} code points;
 *  - cuts prefer paragraph, then sentence, then whitespace boundaries near the
 *    {@link TARGET_CHUNK_CODEPOINTS} target, avoiding sub-{@link MIN_CHUNK_CODEPOINTS}
 *    pieces where possible (a shorter final remainder, or a whole answer shorter
 *    than the minimum, is allowed);
 *  - an empty `text` yields an empty array (no content frames are emitted).
 */
export function splitAnswerIntoChunks(text: string): string[] {
  const cps = Array.from(text); // code points — surrogate-pair safe
  const total = cps.length;
  if (total === 0) return [];

  const chunks: string[] = [];
  let start = 0;
  while (start < total) {
    const remaining = total - start;
    // Final chunk: take everything left (may be shorter than the minimum).
    if (remaining <= MAX_CHUNK_CODEPOINTS) {
      chunks.push(cps.slice(start).join(""));
      break;
    }

    // Candidate cut window: [start+MIN, start+MAX]. Prefer the strongest
    // boundary; among equal strength, the cut closest to start+TARGET; ties go
    // to the larger chunk (fewer, fuller frames). Falls back to a hard cut at
    // the target when no natural boundary exists.
    const lo = start + MIN_CHUNK_CODEPOINTS;
    const hi = start + MAX_CHUNK_CODEPOINTS;
    const target = start + TARGET_CHUNK_CODEPOINTS;
    let bestCut = -1;
    let bestStrength = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let end = lo; end <= hi; end += 1) {
      const strength = boundaryStrength(cps, end);
      if (strength === 0) continue;
      const distance = Math.abs(end - target);
      if (
        strength > bestStrength ||
        (strength === bestStrength &&
          (distance < bestDistance || (distance === bestDistance && end > bestCut)))
      ) {
        bestCut = end;
        bestStrength = strength;
        bestDistance = distance;
      }
    }
    const cut = bestCut === -1 ? target : bestCut;
    chunks.push(cps.slice(start, cut).join(""));
    start = cut;
  }
  return chunks;
}
