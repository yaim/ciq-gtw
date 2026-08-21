/**
 * Fixed CollectivIQ endpoint paths. Knowledge of these paths is confined to
 * this package. Path parameters are percent-encoded through `encodeURIComponent`
 * so an identifier can never alter the path structure.
 */

export const ENDPOINTS = {
  createThread: "/create_thread",
  processMessage: "/process_message",
  getMessages: "/get_messages",
  // `get_threads` backs the OBSERVED-ONLY native-title bridge (a best-effort,
  // account/principal-dependent, provisional read of a thread's server-generated
  // title). It performs no thread-creating POST and is not part of the three core
  // completion operations. See `.agent/docs/collectiviq-upstream-contract.md`.
  getThreads: "/get_threads",
  userEvents: "/user/events",
  availableLlms: "/available_llms",
  // `abortRun` and `threadTokens` are retained ONLY to document the upstream
  // contract surface. They are intentionally not reachable from the discovery
  // session or CLI (token-inspection and abort discovery are disabled until
  // request correlation is safely established) and are wired to no runtime path.
  abortRun: "/abort_run",
  threadTokens: "/thread_tokens",
} as const;

/**
 * `/thread_tokens/{combined_run_id}` with a safely encoded run id. Retained for
 * contract completeness only; not reachable from discovery or any runtime path.
 */
export function threadTokensByRunPath(combinedRunId: string): string {
  return `/thread_tokens/${encodeURIComponent(combinedRunId)}`;
}

/** `/delete_thread/{thread_id}` with a safely encoded thread id. */
export function deleteThreadPath(threadId: string): string {
  return `/delete_thread/${encodeURIComponent(threadId)}`;
}
