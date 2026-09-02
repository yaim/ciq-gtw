/**
 * Synthetic CollectivIQ response fixtures for hermetic contract tests.
 *
 * Every value here is invented and NONE was captured from a live account: no
 * real prompts, answers, identifiers, timestamps, or account data appear. The
 * fixtures are now mixed-evidence, though: some shapes are still purely
 * provisional (invented from the spec contract), while others (notably
 * `processAccepted202` and `messagesCreateTime`) have selected safe field NAMES
 * and types informed by the sanitized, verified-repeatable observations from the
 * two 2026-08-11 authorized password baselines. Field names that stayed masked
 * by structural capture (e.g. message `content`) remain provisional even where a
 * synthetic value exercises the mapping. See the per-fixture notes.
 *
 * `combined_run_id` is one of those verified-repeatable safe NAMES, observed on
 * BOTH the `process_message` `202` and `get_messages` entries. The fixtures below
 * therefore carry it wherever a body must be correlatable, always with an
 * obviously invented value; its selection SEMANTICS (that an entry's run id
 * identifies the submission that produced it) is the gateway's own working rule,
 * not an upstream guarantee.
 */

/** The invented run identifier shared by every correlatable fixture below. */
const SYNTHETIC_RUN_ID = "synthetic-run";

export const createThreadNumeric = { thread_id: 4242, extra_ignored: "x" };
export const createThreadString = { thread_id: "thread-abc", other: 1 };
export const createThreadMissingId = { not_thread_id: 1 };

export const processAccepted = {
  status: "accepted",
  combined_run_id: SYNTHETIC_RUN_ID,
  run_id: "run-xyz",
};
export const processDetailError = { detail: "some upstream validation problem" };

/**
 * Observed-shape (2026-08-11 password baselines, two verified-repeatable runs)
 * `process_message` success: HTTP 202 with a top-level object carrying
 * `combined_run_id`/`status`/`has_rag_files`/`thread_id` and NO `detail`. Values
 * here are SYNTHETIC (never captured from a live account); only the safe field
 * NAMES and types reflect the observation.
 */
export const processAccepted202 = {
  thread_id: "synthetic-thread",
  combined_run_id: SYNTHETIC_RUN_ID,
  status: "processing",
  has_rag_files: false,
};

/**
 * Submit responses the gateway must REFUSE because they carry no usable run id.
 * The run id is the only correlation key the poller has, so a body that omits it,
 * empties it, or types it as something other than a string leaves the completion
 * unable to prove which message is its own — all three fail closed as an upstream
 * protocol error rather than polling without correlation. None of these was
 * observed live; they are invented negatives for the gateway's own rule.
 */
export const processMissingRunId = {
  thread_id: "synthetic-thread",
  status: "processing",
  has_rag_files: false,
};
export const processEmptyRunId = { ...processAccepted202, combined_run_id: "" };
export const processRunIdWrongType = { ...processAccepted202, combined_run_id: 1234 };

export const messagesCombined = {
  messages: [
    {
      source: "gpt",
      content: "individual answer",
      percent_usage: 30,
      created_at: "2026-01-01T00:00:00Z",
      combined_run_id: SYNTHETIC_RUN_ID,
      id: 1,
    },
    {
      source: "combined",
      content: "combined answer",
      created_at: "2026-01-01T00:00:05Z",
      combined_run_id: SYNTHETIC_RUN_ID,
      id: 2,
    },
  ],
  unknown_top_level: true,
};

export const messagesEmpty = { messages: [] };

/**
 * Observed-shape (2026-08-11 password baselines, two verified-repeatable runs)
 * `get_messages` entry metadata: the creation timestamp field is `create_time`
 * (with a separate `updated_at`), not the earlier provisional `created_at`. The
 * normalizer maps `create_time` to `createdAt`. Values are SYNTHETIC; only the
 * safe field names/types reflect the observation. The message `content` field
 * name remained masked by structural capture and is therefore still provisional;
 * a synthetic `content` is included only to exercise the content mapping.
 */
export const messagesCreateTime = {
  messages: [
    {
      source: "gpt",
      content: "synthetic individual answer",
      percent_usage: null,
      create_time: "2026-01-02T00:00:00Z",
      updated_at: "2026-01-02T00:00:01Z",
      combined_run_id: "synthetic-run",
      thread_id: 7,
      id: 21,
    },
  ],
};

/** An entry that names no run at all: structurally valid, never correlatable. */
export const messagesPartial = {
  messages: [{ source: "gpt", content: "only one model so far", percent_usage: 50 }],
};

/** Two messages from the same source AND run, distinguished by timestamp/id metadata. */
export const messagesDuplicateSource = {
  messages: [
    {
      source: "combined",
      content: "first",
      created_at: "2026-01-01T00:00:01Z",
      combined_run_id: SYNTHETIC_RUN_ID,
      id: 10,
    },
    {
      source: "combined",
      content: "second",
      created_at: "2026-01-01T00:00:09Z",
      combined_run_id: SYNTHETIC_RUN_ID,
      id: 11,
    },
  ],
};

export const messagesNullContent = {
  messages: [{ source: "combined", content: null }],
};

/**
 * Message entries whose `combined_run_id` is present but unusable. Unlike an
 * ABSENT run id (which is a legitimately un-correlatable entry and normalizes to
 * null), a wrong-typed or empty value is a structurally broken entry: accepting
 * it as "no run id" would let a malformed snapshot masquerade as an ordinary one,
 * so the whole response is an upstream protocol error.
 */
export const messagesRunIdWrongType = {
  messages: [{ source: "combined", content: "x", combined_run_id: 99 }],
};
export const messagesEmptyRunId = {
  messages: [{ source: "combined", content: "x", combined_run_id: "" }],
};

export const messagesNotArray = { messages: "nope" };
