/**
 * Synthetic CollectivIQ response fixtures for hermetic contract tests.
 *
 * These are invented shapes based on the provisional spec contract, NOT
 * captured from a live account. No real prompts, answers, identifiers, or
 * account data appear here. Once approved live discovery produces sanitized
 * fixtures, they will supersede or confirm these.
 */

export const createThreadNumeric = { thread_id: 4242, extra_ignored: "x" };
export const createThreadString = { thread_id: "thread-abc", other: 1 };
export const createThreadMissingId = { not_thread_id: 1 };

export const processAccepted = { status: "accepted", run_id: "run-xyz" };
export const processDetailError = { detail: "some upstream validation problem" };

export const messagesCombined = {
  messages: [
    {
      source: "gpt",
      content: "individual answer",
      percent_usage: 30,
      created_at: "2026-01-01T00:00:00Z",
      id: 1,
    },
    { source: "combined", content: "combined answer", created_at: "2026-01-01T00:00:05Z", id: 2 },
  ],
  unknown_top_level: true,
};

export const messagesEmpty = { messages: [] };

export const messagesPartial = {
  messages: [{ source: "gpt", content: "only one model so far", percent_usage: 50 }],
};

/** Two messages with the same source, distinguished by timestamp/id metadata. */
export const messagesDuplicateSource = {
  messages: [
    { source: "combined", content: "first", created_at: "2026-01-01T00:00:01Z", id: 10 },
    { source: "combined", content: "second", created_at: "2026-01-01T00:00:09Z", id: 11 },
  ],
};

export const messagesNullContent = {
  messages: [{ source: "combined", content: null }],
};

export const messagesNotArray = { messages: "nope" };
